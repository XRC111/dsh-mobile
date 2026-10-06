/**
 * pnpm-lite — Android 上的**进程内** pnpm 替身。
 *
 * 为什么不是"一个假的 pnpm 可执行文件"：
 *   Android 10+ 对 app 私有目录（/data/data/<pkg>/）禁止 execve，
 *   实测直接执行该目录下任何脚本都是 exit=126 Permission denied；
 *   /sdcard、/storage/emulated 挂载带 noexec（同样 126）；
 *   /data/local/tmp、/system/bin 不可写。
 *   也就是说：这台设备上**不存在**"可写 + 可执行"的位置，
 *   任何靠 spawn/execa 起 pnpm 的路线在物理上就不成立。
 *
 * 所以这里把 pnpm 的**语义**直接在 dsh 自己的 Node 进程里执行：
 *   registry 拉 packument → 解析版本 → 下载 tarball → 校验 integrity
 *   → gunzip + 解 ustar → 落 node_modules → 写 package.json
 *   → 需要时写 compatibility.json 版本豁免。
 *
 * 覆盖 dshmarket 实际会发的子命令：
 *   add <spec>... | remove <name>... | install | update [name] | list | view | --version
 *
 * 不支持（会明确报错而不是假装成功）：
 *   git+/github: 源、原生 addon 的编译、生命周期脚本、lockfile 语义。
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE_DIR = fileURLToPath(new URL('.', import.meta.url));
const NM = join(PROFILE_DIR, 'node_modules');
const MANIFEST_PATH = join(PROFILE_DIR, 'package.json');
const COMPAT_PATH = join(PROFILE_DIR, 'compatibility.json');
const LOG_PATH = join(PROFILE_DIR, 'pnpm-lite.log');

const REGISTRY = 'https://registry.npmjs.org/';
const SHIM_VERSION = '10.0.0-dsh-android-shim';
const MAX_DEPTH = 25;

/** 当前正在跑的操作（供 cancel() 打断）。 */
let CURRENT = null;

// ───────────────────────────── 小工具 ─────────────────────────────

function logLine(obj) {
    try {
        const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
        // 追加式写日志；失败不影响安装
        appendFileSync(LOG_PATH, line + '\n');
    } catch { /* 日志是尽力而为 */ }
}

function cstr(buf) {
    const i = buf.indexOf(0);
    return (i === -1 ? buf : buf.subarray(0, i)).toString('utf8');
}

function done(ctx, exitCode) {
    const out = ctx.stdout.length > 0 ? ctx.stdout.join('\n') + '\n' : '';
    const err = ctx.stderr.length > 0 ? ctx.stderr.join('\n') + '\n' : '';
    logLine({ op: ctx.verb, exitCode, out: out.slice(-500), err: err.slice(-500) });
    return {
        exitCode,
        timedOut: false,
        stdout: out,
        stderr: err,
        cancelled: ctx.cancelled === true,
        ...(ctx.resolvedNpmVersion === undefined ? {} : { resolvedNpmVersion: ctx.resolvedNpmVersion }),
    };
}

// ─────────────────────────── semver 子集 ───────────────────────────

function parseVer(v) {
    const m = /^[v=\s]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(v));
    if (m === null) return null;
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') };
}

function cmpPre(a, b) {
    if (a.length === 0 && b.length === 0) return 0;
    if (a.length === 0) return 1;   // 正式版 > 预发布
    if (b.length === 0) return -1;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const x = a[i];
        const y = b[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) {
            const d = Number(x) - Number(y);
            if (d !== 0) return d < 0 ? -1 : 1;
        } else if (xn !== yn) {
            return xn ? -1 : 1;     // 数字标识符优先级低于字母
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

function cmpVer(a, b) {
    for (let i = 0; i < 3; i += 1) {
        if (a.n[i] !== b.n[i]) return a.n[i] < b.n[i] ? -1 : 1;
    }
    return cmpPre(a.pre, b.pre);
}

function caretUpper(v) {
    const [M, m, p] = v.n;
    if (M > 0) return { n: [M + 1, 0, 0], pre: [] };
    if (m > 0) return { n: [0, m + 1, 0], pre: [] };
    return { n: [0, 0, p + 1], pre: [] };
}

function tildeUpper(v) {
    const [M, m, p] = v.n;
    if (M > 0) return { n: [M, m + 1, 0], pre: [] };
    if (m > 0) return { n: [0, m + 1, 0], pre: [] };
    return { n: [0, 0, p + 1], pre: [] };
}

/**
 * 匹配单个比较式（不含 ||）。
 * 采用 includePrerelease 语义（与 dsh 自己的 peer 检查一致）：
 * 预发布版本照常参与区间比较，不额外要求 [major,minor,patch] 元组相同。
 */
function matchComparator(token, ver) {
    const t = token.trim();
    if (t === '' ) return true;
    if (t === '*' || t === 'x' || t === 'X') return true;

    if (t.startsWith('^') || t.startsWith('~')) {
        const base = parseVer(t.slice(1));
        if (base === null) return false;
        const up = t.startsWith('^') ? caretUpper(base) : tildeUpper(base);
        return cmpVer(ver, base) >= 0 && cmpVer(ver, up) < 0;
    }
    const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(t);
    if (m === null) return false;
    const op = m[1] ?? '=';
    const rhsRaw = m[2].trim();

    // 部分版本 / 通配：1.x、1.2.x、1、1.2
    if (/[xX*]/.test(rhsRaw) || /^\d+(\.\d+)?$/.test(rhsRaw)) {
        const parts = rhsRaw.split('.');
        const nums = [];
        let wild = false;
        for (const p of parts) {
            if (p === 'x' || p === 'X' || p === '*') { wild = true; break; }
            nums.push(Number(p));
        }
        for (let i = 0; i < nums.length; i += 1) if (ver.n[i] !== nums[i]) return false;
        if (wild || nums.length < 3) return op === '=' || op === '>=';
        return op === '=' ? true : true;
    }
    const rhs = parseVer(rhsRaw);
    if (rhs === null) return false;
    const c = cmpVer(ver, rhs);
    switch (op) {
        case '=': return c === 0;
        case '>': return c > 0;
        case '>=': return c >= 0;
        case '<': return c < 0;
        case '<=': return c <= 0;
        default: return false;
    }
}

/** npm range：空格 = AND，|| = OR。 */
function matchRange(range, version) {
    const v = parseVer(version);
    if (v === null) return false;
    const r = String(range ?? '').trim();
    if (r === '') return true;
    return r.split('||').some((alt) => {
        const tokens = alt.trim().split(/\s+/).filter((s) => s !== '');
        if (tokens.length === 0) return true;
        return tokens.every((tok) => matchComparator(tok, v));
    });
}

function cmpDesc(a, b) {
    const pa = parseVer(a);
    const pb = parseVer(b);
    if (pa === null) return 1;
    if (pb === null) return -1;
    return -cmpVer(pa, pb);
}

// ─────────────────────────── tar / integrity ───────────────────────────

function parseTar(buf) {
    const entries = [];
    let off = 0;
    let longName = null;
    let paxPath = null;
    while (off + 512 <= buf.length) {
        const hdr = buf.subarray(off, off + 512);
        let allZero = true;
        for (let i = 0; i < 512; i += 1) if (hdr[i] !== 0) { allZero = false; break; }
        if (allZero) break;

        const rawName = cstr(hdr.subarray(0, 100));
        const size = parseInt(cstr(hdr.subarray(124, 136)).trim() || '0', 8) || 0;
        const type = String.fromCharCode(hdr[156] === 0 ? 48 : hdr[156]);
        const prefix = cstr(hdr.subarray(345, 500));
        const dataStart = off + 512;
        const data = buf.subarray(dataStart, dataStart + size);
        off = dataStart + Math.ceil(size / 512) * 512;

        if (type === 'L') { longName = cstr(data); continue; }
        if (type === 'x' || type === 'g') {
            const txt = data.toString('utf8');
            const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(txt);
            if (m !== null) paxPath = m[1];
            continue;
        }
        let name = longName !== null ? longName : (prefix !== '' ? prefix + '/' + rawName : rawName);
        longName = null;
        if (paxPath !== null) { name = paxPath; paxPath = null; }
        if (name === '') continue;
        if (type === '5') { entries.push({ path: name, dir: true }); continue; }
        if (type === '0' || type === '' || type === '7') entries.push({ path: name, dir: false, data });
        // 其它类型（符号链接/硬链接/设备）一律跳过——插件包里不应出现
    }
    return entries;
}

/** npm tarball 顶层统一是 package/（历史原因），剥掉这一层。 */
function stripCommonPrefix(entries) {
    let prefix = null;
    for (const e of entries) {
        const seg = e.path.split('/')[0];
        if (seg === '' || seg === '.') return entries;
        if (prefix === null) prefix = seg;
        else if (prefix !== seg) return entries;
    }
    if (prefix === null) return entries;
    return entries
        .map((e) => ({ path: e.path.slice(prefix.length + 1), dir: e.dir, data: e.data }))
        .filter((e) => e.path !== '');
}

async function extractInto(entries, dest) {
    await mkdir(dest, { recursive: true });
    for (const e of entries) {
        const rel = e.path.replace(/\\/g, '/');
        if (rel.startsWith('/') || rel.includes('\0')) throw new Error(`unsafe tar path: ${rel}`);
        if (rel.split('/').some((s) => s === '..')) throw new Error(`unsafe tar path: ${rel}`);
        const target = join(dest, rel);
        if (!target.startsWith(dest + sep)) throw new Error(`tar path escapes destination: ${rel}`);
        if (e.dir === true) { await mkdir(target, { recursive: true }); continue; }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, e.data);
    }
}

function verifyIntegrity(integrity, buf, name, version) {
    if (typeof integrity !== 'string') return;
    const m = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
    if (m === null) return;
    const actual = createHash(m[1]).update(buf).digest('base64');
    if (actual !== m[2]) throw new Error(`integrity mismatch for ${name}@${version} (${m[1]})`);
}

// ─────────────────────────── registry 访问 ───────────────────────────

function encodeName(name) {
    return name.replace(/\//g, '%2f');
}

async function fetchJson(url, headers) {
    const res = await fetch(url, {
        headers: { Accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'pnpm-lite/dsh-android', ...headers },
    });
    if (!res.ok) throw new Error(`registry ${url} -> HTTP ${res.status}`);
    return res.json();
}

async function packument(name) {
    return fetchJson(REGISTRY + encodeName(name));
}

function resolveFromDoc(doc, name, range) {
    const tags = doc['dist-tags'] ?? {};
    const r = String(range ?? '').trim();
    if (r === '' || r === 'latest') {
        if (typeof tags.latest === 'string') return tags.latest;
        throw new Error(`no dist-tag latest for ${name}`);
    }
    if (typeof tags[r] === 'string') return tags[r];
    const versions = Object.keys(doc.versions ?? {});
    if (versions.includes(r)) return r;
    const cands = versions.filter((v) => matchRange(r, v)).sort(cmpDesc);
    if (cands.length === 0) throw new Error(`no version of ${name} satisfies ${JSON.stringify(r)}`);
    return cands[0];
}

// ─────────────────────────── 安装实现 ───────────────────────────

async function readJson(path, fallback) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function readManifest() {
    const m = await readJson(MANIFEST_PATH, null);
    if (m === null) throw new Error(`cannot read profile manifest ${MANIFEST_PATH}`);
    if (typeof m.dependencies !== 'object' || m.dependencies === null) m.dependencies = {};
    return m;
}

async function writeManifest(m) {
    await writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
}

function runtimeVersion() {
    const candidates = [
        join(PROFILE_DIR, '..', '..', '..', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ];
    for (const c of candidates) {
        try {
            const m = JSON.parse(readFileSyncSafe(c));
            if (typeof m.version === 'string') return m.version;
        } catch { /* 下一个候选 */ }
    }
    return null;
}

function readFileSyncSafe(path) {
    // 只读一次小文件；用同步 API 避免把 runtimeVersion 变成 async
    return readFileSync(path, 'utf8');
}

function peerNeedsExemption(manifest, rtVersion) {
    if (rtVersion === null) return false;
    const peers = manifest.peerDependencies;
    if (typeof peers !== 'object' || peers === null) return false;
    for (const [k, range] of Object.entries(peers)) {
        if (k !== '@deepseek-ai/dsh' && !k.startsWith('@deepseek-ai/dsh-')) continue;
        if (typeof range !== 'string') continue;
        if (!matchRange(range, rtVersion)) return true;
    }
    return false;
}

async function installOne(doc, name, range, ctx) {
    const version = resolveFromDoc(doc, name, range);
    const dest = join(NM, name);

    try {
        const cur = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'));
        if (cur.name === name && cur.version === version) {
            ctx.stdout.push(`Reused ${name}@${version}`);
            return { name, version, manifest: cur, reused: true };
        }
    } catch { /* 未安装或不完整，继续下载 */ }

    const vinfo = doc.versions?.[version];
    if (vinfo === undefined) throw new Error(`${name}@${version} missing from packument`);
    const tarball = vinfo.dist?.tarball;
    if (typeof tarball !== 'string') throw new Error(`${name}@${version} has no dist.tarball`);

    if (ctx.cancelled) throw new Error('cancelled');
    ctx.stdout.push(`Downloading ${name}@${version}`);
    const res = await fetch(tarball, { headers: { 'user-agent': 'pnpm-lite/dsh-android' } });
    if (!res.ok) throw new Error(`tarball ${tarball} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    verifyIntegrity(vinfo.dist?.integrity, buf, name, version);

    const entries = stripCommonPrefix(parseTar(gunzipSync(buf)));
    if (entries.length === 0) throw new Error(`${name}@${version}: tarball produced no files`);
    await rm(dest, { recursive: true, force: true });
    await extractInto(entries, dest);

    const manifest = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'));
    ctx.stdout.push(`Added ${name}@${version}`);
    return { name, version, manifest, reused: false };
}

/** 递归安装 dependencies 里缺失的部分（不装 peers，与 profile 的 autoInstallPeers:false 一致）。 */
async function installTree(name, range, ctx, seen, depth) {
    if (depth > MAX_DEPTH) { ctx.stderr.push(`warning: depth cap reached at ${name}`); return null; }
    if (seen.has(name)) return null;
    seen.add(name);

    const doc = await packument(name);
    const installed = await installOne(doc, name, range, ctx);

    const deps = installed.manifest.dependencies ?? {};
    for (const [depName, depRange] of Object.entries(deps)) {
        if (typeof depRange !== 'string') continue;
        if (existsSync(join(NM, depName, 'package.json'))) continue;
        if (seen.has(depName)) continue;
        try {
            await installTree(depName, depRange, ctx, seen, depth + 1);
        } catch (e) {
            // 单个传递依赖失败不整体失败，但要如实报出来
            ctx.stderr.push(`warning: dependency ${depName}@${depRange} of ${name} not installed: ${String(e?.message ?? e)}`);
        }
    }
    return installed;
}

/** 顶层 add：装包 + 写 manifest(deps/bundles) + 需要时写版本豁免。 */
async function addTopLevel(spec, ctx, seen) {
    const parsed = parseSpec(spec);
    if (parsed === null) throw new Error(`unsupported install spec: ${JSON.stringify(spec)}`);
    const { name, range } = parsed;

    const installed = await installTree(name, range, ctx, seen, 0);
    if (installed === null) return;

    const manifest = await readManifest();
    manifest.dependencies[name] = installed.version;

    // bundle 类插件（声明了 dsh.bundle.patch）需要进 bundles 才会被组合
    const declaresBundle = typeof installed.manifest.dsh?.bundle?.patch === 'string';
    if (declaresBundle) {
        const bundles = manifest.dsh?.profile?.bundles;
        if (Array.isArray(bundles) && !bundles.includes(name)) {
            bundles.push(name);
            ctx.stdout.push(`Activated bundle ${name}`);
        }
    } else {
        ctx.stdout.push(`note: ${name} declares no dsh.bundle.patch; add a patch row to activate it`);
    }
    await writeManifest(manifest);

    if (name === 'dshmarket') await ensureDshmarketPatched(ctx);

    // 版本豁免：peer 对不上时才写
    const rt = runtimeVersion();
    if (peerNeedsExemption(installed.manifest, rt)) {
        const compat = await readJson(COMPAT_PATH, {});
        const key = `${name}@${installed.version}`;
        const list = Array.isArray(compat[key]) ? compat[key] : [];
        if (!list.includes(rt)) list.push(rt);
        compat[key] = list;
        await writeFile(COMPAT_PATH, JSON.stringify(compat, null, 2) + '\n');
        ctx.stderr.push(`warning: ${key} peer range does not cover dsh ${rt}; wrote exact-version exemption`);
    }

    ctx.resolvedNpmVersion = installed.version;
}

function parseSpec(spec) {
    const s = String(spec ?? '').trim();
    if (s === '') return null;
    if (/^(git\+|github:|https?:|file:|link:|workspace:)/.test(s)) return null;
    let name;
    let range = '';
    if (s.startsWith('@')) {
        const slash = s.indexOf('/');
        if (slash === -1) return null;
        const at = s.indexOf('@', slash);
        if (at === -1) { name = s; } else { name = s.slice(0, at); range = s.slice(at + 1); }
    } else {
        const at = s.indexOf('@');
        if (at === -1) { name = s; } else { name = s.slice(0, at); range = s.slice(at + 1); }
    }
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) return null;
    return { name, range };
}

// ─────────────────────────── 子命令 ───────────────────────────

async function cmdAdd(ctx, targets) {
    if (targets.length === 0) throw new Error('add requires at least one package spec');
    const seen = new Set();
    for (const t of targets) {
        if (ctx.cancelled) { ctx.stdout.push('Cancelled'); return 0; }
        await addTopLevel(t, ctx, seen);
    }
    return 0;
}

async function cmdRemove(ctx, names) {
    if (names.length === 0) throw new Error('remove requires at least one package name');
    const manifest = await readManifest();
    const compat = await readJson(COMPAT_PATH, {});
    let compatTouched = false;
    for (const name of names) {
        const dest = join(NM, name);
        const existed = existsSync(dest);
        await rm(dest, { recursive: true, force: true });
        if (Object.hasOwn(manifest.dependencies, name)) delete manifest.dependencies[name];
        const bundles = manifest.dsh?.profile?.bundles;
        if (Array.isArray(bundles)) {
            const i = bundles.indexOf(name);
            if (i !== -1) bundles.splice(i, 1);
        }
        for (const key of Object.keys(compat)) {
            if (key.startsWith(name + '@')) { delete compat[key]; compatTouched = true; }
        }
        ctx.stdout.push(existed ? `Removed ${name}` : `Removed ${name} (was not installed)`);
    }
    await writeManifest(manifest);
    if (compatTouched) await writeFile(COMPAT_PATH, JSON.stringify(compat, null, 2) + '\n');
    return 0;
}

async function cmdInstall(ctx) {
    const manifest = await readManifest();
    const missing = [];
    for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (!existsSync(join(NM, name, 'package.json'))) missing.push(name);
    }
    if (missing.length === 0) {
        ctx.stdout.push('Already up to date');
        return 0;
    }
    const seen = new Set();
    for (const name of missing) {
        await addTopLevel(`${name}@${manifest.dependencies[name]}`, ctx, seen);
    }
    return 0;
}

async function cmdList(ctx) {
    const manifest = await readManifest();
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        let version = '(missing)';
        try {
            version = JSON.parse(await readFile(join(NM, name, 'package.json'), 'utf8')).version ?? '?';
        } catch { /* 保持 missing */ }
        ctx.stdout.push(`${name} ${version} ${range}`);
    }
    return 0;
}

async function cmdView(ctx, args) {
    const spec = args[0];
    if (spec === undefined) throw new Error('view requires a package spec');
    const parsed = parseSpec(spec);
    if (parsed === null) throw new Error(`unsupported view spec: ${JSON.stringify(spec)}`);
    const doc = await packument(parsed.name);
    const version = resolveFromDoc(doc, parsed.name, parsed.range);
    const vinfo = doc.versions?.[version] ?? {};
    ctx.stdout.push(JSON.stringify({
        name: parsed.name,
        version,
        description: vinfo.description ?? doc.description ?? '',
        peerDependencies: vinfo.peerDependencies ?? {},
    }));
    return 0;
}

// ─────────── dshmarket 自更新后的补丁自愈 ───────────
//
// 市场的"更新自己"会把新版 dsh-cli.js 解压覆盖上来，我们挂的进程内替身随之消失，
// 下一次启动市场就又会去 spawn pnpm。这里在装完 dshmarket 之后检查标记，
// 缺了就重新打一遍；锚点对不上（上游改了函数签名）就如实记一条警告，不硬来。

const DSMARKET_CLI = join(NM, 'dshmarket', 'lib', 'dsh-cli.js');

const HEADER_BLOCK = [
    "import { fetchNpmLatest } from './updates.js';",
    '/* dsh-android:pnpm-lite — 见 profiles/web/pnpm-lite.mjs',
    ' * Android 上不存在"可写+可执行"的位置（app 目录 execve 被 SELinux 拒、外置存储 noexec），',
    ' * 因此任何 spawn(\'pnpm\') 都必然失败。这里改为在进程内执行 pnpm 的语义。',
    ' * 加载失败时 FAKE 保持 null，退回本文件原有的 spawn 行为。 */',
    'const FAKE = await (async () => {',
    '    try {',
    "        return (await import(new URL('../../../pnpm-lite.mjs', import.meta.url).href)).default;",
    '    } catch (error) {',
    "        try { logEvent('warn', 'setup-pnpm', `pnpm-lite unavailable: ${String(error?.message ?? error)}`); } catch { /* 尽力而为 */ }",
    '        return null;',
    '    }',
    '})();',
].join('\n');

const DSMARKET_PATCHES = [
    {
        find: "import { fetchNpmLatest } from './updates.js';",
        replace: HEADER_BLOCK,
        marker: 'const FAKE = await (async () => {',
    },
    {
        find: 'export function cancelActive() {\n    if (activeDesktopOperation !== null) {',
        replace: 'export function cancelActive() {\n    /* dsh-android:pnpm-lite */ if (FAKE !== null && FAKE.cancel()) return true;\n    if (activeDesktopOperation !== null) {',
        marker: 'FAKE.cancel()',
    },
    {
        find: 'export function probePnpm() {\n    if (pnpmReady || hostPnpmReady)',
        replace: 'export function probePnpm() {\n    /* dsh-android:pnpm-lite */ if (FAKE !== null) return Promise.resolve(true);\n    if (pnpmReady || hostPnpmReady)',
        marker: 'if (FAKE !== null) return Promise.resolve(true);',
    },
    {
        find: 'export async function provisionPnpm() {\n    // A host that ships a package manager has nothing to provision, and asking',
        replace: 'export async function provisionPnpm() {\n    /* dsh-android:pnpm-lite */ if (FAKE !== null) return { ok: true };\n    // A host that ships a package manager has nothing to provision, and asking',
        marker: 'if (FAKE !== null) return { ok: true };',
    },
    {
        find: 'export function runDshPlugin(profile, pluginArgs) {\n    const { file, args, cwd, viaShell } = dshArgv();',
        replace: 'export function runDshPlugin(profile, pluginArgs) {\n    /* dsh-android:pnpm-lite */ if (FAKE !== null) return FAKE.run(profile, pluginArgs);\n    const { file, args, cwd, viaShell } = dshArgv();',
        marker: 'if (FAKE !== null) return FAKE.run(profile, pluginArgs);',
    },
];

async function ensureDshmarketPatched(ctx) {
    try {
        if (!existsSync(DSMARKET_CLI)) return;
        let text = await readFile(DSMARKET_CLI, 'utf8');
        if (text.includes('/* dsh-android:pnpm-lite */ if (FAKE !== null) return FAKE.run')) return; // 补丁还在

        let applied = 0;
        const missed = [];
        for (const p of DSMARKET_PATCHES) {
            if (text.includes(p.marker)) { applied += 1; continue; }
            if (!text.includes(p.find)) { missed.push(p.find.split('\n')[0]); continue; }
            text = text.replace(p.find, p.replace);
            applied += 1;
        }
        if (applied > 0 && missed.length === 0) {
            await writeFile(DSMARKET_CLI, text);
            ctx.stdout.push('Re-applied the Android pnpm shim to the updated dshmarket');
            logLine({ op: 'self-heal', applied });
        } else {
            ctx.stderr.push(`warning: dshmarket was updated and ${missed.length} shim anchor(s) no longer match (${missed.join(' | ')}); installs will fall back to spawning pnpm and fail on Android`);
            logLine({ op: 'self-heal', applied, missed });
        }
    } catch (e) {
        ctx.stderr.push(`warning: could not re-apply the Android pnpm shim: ${String(e?.message ?? e)}`);
    }
}

// ─────────────────────────── 入口 ───────────────────────────

export async function run(profile, argv) {
    const ctx = { verb: '', stdout: [], stderr: [], cancelled: false, profile };
    CURRENT = ctx;
    try {
        const args = (Array.isArray(argv) ? argv : []).filter((a) => typeof a === 'string');
        const nonFlag = args.filter((a) => !a.startsWith('-'));
        if (nonFlag.length === 0 && args.includes('--version')) {
            ctx.verb = '--version';
            ctx.stdout.push(SHIM_VERSION);
            return done(ctx, 0);
        }
        const verb = nonFlag[0] ?? '';
        const rest = nonFlag.slice(1);
        ctx.verb = verb;

        switch (verb) {
            case '--version':
            case 'version':
                ctx.stdout.push(SHIM_VERSION);
                return done(ctx, 0);
            case 'add':
            case 'i':
                return done(ctx, await cmdAdd(ctx, rest));
            case 'remove':
            case 'rm':
            case 'uninstall':
                return done(ctx, await cmdRemove(ctx, rest));
            case 'install':
                return done(ctx, await cmdInstall(ctx));
            case 'update':
            case 'up':
                return done(ctx, rest.length > 0
                    ? await cmdAdd(ctx, rest.map((r) => (r.includes('@') ? r : `${r}@latest`)))
                    : await cmdInstall(ctx));
            case 'list':
            case 'ls':
                return done(ctx, await cmdList(ctx));
            case 'view':
            case 'info':
                return done(ctx, await cmdView(ctx, rest));
            default:
                ctx.stderr.push(`pnpm-lite: unsupported pnpm subcommand ${JSON.stringify(verb)}; this Android shim implements add/remove/install/update/list/view only`);
                return done(ctx, 1);
        }
    } catch (e) {
        ctx.stderr.push(`pnpm-lite: ${String(e?.message ?? e)}`);
        return done(ctx, 1);
    } finally {
        CURRENT = null;
    }
}

/** 打断当前操作；与 dshmarket 的 cancelActive() 对齐。 */
export function cancel() {
    if (CURRENT === null) return false;
    CURRENT.cancelled = true;
    return true;
}

export default { run, cancel };
