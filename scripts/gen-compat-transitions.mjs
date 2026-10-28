#!/usr/bin/env node
/**
 * 生成兼容层的差分数据 `packages/dsh-legacy-compat/data/transitions.json`。
 *
 * ── 这份数据用来干什么 ──────────────────────────────────────────────────────
 * 判定本身不依赖它：能不能跑，是拿**当前宿主**去 resolve 包、去对符号（见
 * lib/surface.mjs）。数据只负责回答「为什么没了、该换成什么」—— 也就是给
 * 用户看的解释。所以它过期不会让判定变错，只会让解释变旧。
 *
 * ── 为什么必须可重跑 ────────────────────────────────────────────────────────
 * dsh 每次跟版（0.2.1 → 0.2.2 …）都可能删包改符号。这份数据如果靠手工维护，
 * 一定会腐烂，而腐烂的表现是「兼容层给出的替代建议指向一个也不存在的包」。
 * 所以：跟版时把新运行时加进 --runtime 列表重跑一次即可。
 *
 * 用法（需要先装好几份运行时，见 README 的「复现差分数据」）：
 *
 *   node scripts/gen-compat-transitions.mjs \
 *     --runtime 0.1.5=/tmp/rt-015 \
 *     --runtime 0.1.7=/tmp/rt-0.1.7 \
 *     --runtime 0.2.0=/tmp/rt-0.2.0 \
 *     --runtime 0.2.1=/tmp/dsh-mobile/build/runtime-stage
 *
 * 运行时目录指 npm install 的根（里面是 node_modules/@deepseek-ai/...）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'packages/dsh-legacy-compat/data/transitions.json');

/** 最大扫描字节数：超过就认为是压缩产物，符号不可信。 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
    const runtimes = [];
    let out = OUT;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--runtime') {
            const [version, dir] = String(argv[++i] ?? '').split('=');
            if (!version || !dir) throw new Error('--runtime 需要 版本=目录 形式');
            runtimes.push({ version, dir: path.resolve(dir) });
        } else if (arg === '--out') {
            out = path.resolve(argv[++i]);
        }
    }
    if (runtimes.length < 2) throw new Error('至少需要两个 --runtime');
    runtimes.sort((a, b) => compareVersions(a.version, b.version));
    return { runtimes, out };
}

/** 仅用于给 --runtime 排序的粗略比较（不处理 prerelease 的完整语义）。 */
function compareVersions(a, b) {
    const pa = String(a).split('-')[0].split('.').map(Number);
    const pb = String(b).split('-')[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    // 同号版本：release > prerelease
    const aPre = String(a).includes('-');
    const bPre = String(b).includes('-');
    if (aPre !== bPre) return aPre ? -1 : 1;
    return String(a).localeCompare(String(b));
}

function installedPackages(root) {
    const dir = path.join(root, 'node_modules/@deepseek-ai');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => '@deepseek-ai/' + e.name)
        .sort();
}

function entryOf(pkgDir) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch {
        return null;
    }
    const pick = (v) => (typeof v === 'string' ? v : (v?.default ?? v?.import ?? v?.node ?? v?.require));
    const ex = manifest.exports;
    if (typeof ex === 'string') return ex;
    if (ex !== null && typeof ex === 'object') {
        const root = pick(ex['.'] ?? ex);
        if (typeof root === 'string') return root;
        for (const [key, value] of Object.entries(ex)) {
            if (key.includes('*')) continue;
            const candidate = pick(value);
            if (typeof candidate === 'string') return candidate;
        }
    }
    return manifest.module ?? manifest.main ?? 'index.js';
}

function symbolsOf(file) {
    let text;
    try {
        if (fs.statSync(file).size > MAX_SCAN_BYTES) return null;
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    const names = new Set();
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const item = part.trim();
            if (item === '') continue;
            const as = item.split(/\s+as\s+/);
            const name = (as[1] ?? as[0]).trim().replace(/^type\s+/, '');
            if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
    }
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    if (/export\s+\*\s+from/.test(text)) return null;
    for (const m of text.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
    for (const m of text.matchAll(/^exports\[["']([^"']+)["']\]\s*=/gm)) names.add(m[1]);
    return names;
}

/** 从 dsh 自己的位置解析 —— 插件解析 peer 依赖时走的就是这条路径。 */
function resolverFor(root) {
    const anchor = path.join(root, 'node_modules/@deepseek-ai/dsh/package.json');
    if (!fs.existsSync(anchor)) return null;
    const req = createRequire(anchor);
    return (pkg) => {
        try {
            return req.resolve(pkg);
        } catch {
            return null;
        }
    };
}

/** 客户端包：由浏览器侧模块表提供，Node 解析不到是正常的。 */
const isClientPackage = (name) => /dsh-client-/.test(name);

function snapshot({ version, dir }) {
    const resolve = resolverFor(dir);
    if (resolve === null) throw new Error(`${dir} 里没有 @deepseek-ai/dsh，不是运行时目录`);
    const packages = new Map();
    for (const name of installedPackages(dir)) {
        const pkgDir = path.join(dir, 'node_modules', name);
        const entry = entryOf(pkgDir);
        const symbols = entry === null ? null : symbolsOf(path.join(pkgDir, entry));
        packages.set(name, {
            resolvable: resolve(name) !== null,
            symbols,
            client: isClientPackage(name),
        });
    }
    return { version, dir, packages, all: installedPackages(dir) };
}

/**
 * 改名/替代关系：**只读人工维护的 data/renames.json**。
 *
 * ⚠️ 试过按名字相似度自动生成，结果不可用：
 *      `dsh-hook-protocol` → `dsh-hmr`、`dsh-invariants` → `dsh-fs`、
 *      `dsh-webhook` → `dsh-web` —— 全是字面相近、语义无关。
 *    这份数据会直接显示成「迁移建议」，指错方向比不给建议更糟。
 *    所以：自动生成只负责发现「什么没了」，至于「换成什么」由人确认。
 */
function loadRenames() {
    const file = path.join(ROOT, 'packages/dsh-legacy-compat/data/renames.json');
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).renames ?? {};
    } catch (error) {
        throw new Error('data/renames.json 解析失败：' + String(error));
    }
}

function main() {
    const { runtimes, out } = parseArgs(process.argv.slice(2));
    const snaps = runtimes.map(snapshot);
    const newest = snaps.at(-1);

    const renames = loadRenames();
    const removedPackages = new Map();
    const removedSymbols = new Map();
    const clientPackages = new Map();
    const segments = [];

    for (let i = 1; i < snaps.length; i++) {
        const prev = snaps[i - 1];
        const next = snaps[i];
        const label = `${prev.version}→${next.version}`;
        let goneCount = 0;
        let addedCount = 0;
        let symbolGoneCount = 0;

        for (const [name, info] of prev.packages) {
            const after = next.packages.get(name);
            // 判定「还在不在」用 resolvable，不用目录里有没有 —— 见 surface.mjs 的说明。
            if (after === undefined || !after.resolvable) {
                if (info.client || isClientPackage(name)) {
                    // 客户端包的可解析性不稳定，单独记录，不当作断裂。
                    clientPackages.set(name, { changedAt: label, resolvableBefore: info.resolvable, resolvableAfter: after?.resolvable ?? false });
                } else if (info.resolvable) {
                    goneCount += 1;
                    if (!removedPackages.has(name)) {
                        const rename = renames[name];
                        removedPackages.set(name, {
                            package: name,
                            removedAt: label,
                            // rename 为空表示「确认没有替代」；缺字段表示「还没人确认过」—— 两者在 UI 上要分开说。
                            repairedBy: rename?.to ?? null,
                            note: rename?.note ?? null,
                        });
                    }
                }
                continue;
            }
            if (!prev.all.includes(name)) addedCount += 1;
            if (info.symbols === null || after.symbols === null) continue;
            const gone = [...info.symbols].filter((s) => !after.symbols.has(s));
            if (gone.length > 0) {
                symbolGoneCount += gone.length;
                const bucket = removedSymbols.get(name) ?? new Map();
                for (const s of gone) if (!bucket.has(s)) bucket.set(s, label);
                removedSymbols.set(name, bucket);
            }
        }
        addedCount = next.all.filter((n) => !prev.all.includes(n)).length;

        segments.push({ from: prev.version, to: next.version, packagesGone: goneCount, packagesAdded: addedCount, symbolsGone: symbolGoneCount });
    }

    const data = {
        schema: 'dsh-legacy-compat/transitions/v1',
        note: '由 scripts/gen-compat-transitions.mjs 从真实 npm 运行时生成。只记录两类会让旧插件确定跑不了的变化：' +
              '宿主侧包消失、导出符号被删。客户端包（dsh-client-*）单独记录，因为它们由浏览器侧模块表提供，' +
              'Node 解析不到属正常现象，不能据此判死。',
        versions: snaps.map((s) => s.version),
        segments,
        removedPackages: [...removedPackages.values()],
        removedSymbols: [...removedSymbols.entries()].map(([name, map]) => {
            const removedAt = new Map();
            for (const [symbol, at] of map) removedAt.set(symbol, at);
            return { package: name, symbols: Object.fromEntries(removedAt) };
        }),
        clientPackages: [...clientPackages.entries()].map(([name, info]) => ({ package: name, ...info })),
    };

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(data, null, 1) + '\n');

    console.log('已写入', path.relative(ROOT, out));
    console.log('版本:', data.versions.join(' → '));
    for (const s of segments) {
        console.log(`  ${s.from}→${s.to}: 消失 ${s.packagesGone} 包 / 新增 ${s.packagesAdded} 包 / 删符号 ${s.symbolsGone} 个`);
    }
    console.log('宿主侧消失的包', data.removedPackages.length, '个');
    for (const p of data.removedPackages) console.log('  -', p.package, `(${p.removedAt})`, p.repairedBy ? '→ ' + p.repairedBy : '（无替代）');
    console.log('删除符号的包', data.removedSymbols.length, '个');
    console.log('客户端包变动', data.clientPackages.length, '个（不参与判定）');
}

main();
