#!/usr/bin/env node
/**
 * 原生模块体检：扫描交付物里所有 .node / .so，逐项检查 Android 兼容性。
 *
 * 检查项（每项都能在开发机上跑，不需要设备）：
 *   1. ELF 架构与位数（必须 aarch64）
 *   2. DT_NEEDED：.node 插件是否声明了 libnode.so —— 缺了就无法解析 napi_*
 *      （症状：dlopen failed: cannot locate symbol "napi_create_function"）
 *   3. 未解析的 napi_* 符号数量（配合上一条判断风险）
 *   4. glibc 专有符号（Android 用 bionic，这些符号不存在）
 *   5. 16KB 页对齐（Android 15+ 对 16KB 页设备的硬要求）
 *   6. 危险的 libc 版本化符号（GLIBC_* 版本标签 = 从桌面 Linux 拿来的）
 *
 * 用法：
 *   node scripts/audit-native.mjs                # 扫默认交付物
 *   node scripts/audit-native.mjs <目录...>       # 扫指定目录
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NDK = 'D:/Android/SDK/ndk/28.2.13676358';
const READELF = path.join(NDK, 'toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-readelf.exe');

const DEFAULT_ROOTS = [
    path.join(ROOT, 'build/runtime-stage'),
    path.join(ROOT, 'plugins'),
    path.join(ROOT, 'app/src/main/jniLibs'),
];

/**
 * 不算交付物的路径 —— 必须与 pack-runtime.mjs 的 EXCLUDED_PLUGINS 保持一致。
 *
 * subprocess-rs 依赖的 rs-cross-spawn.node 有 41 个未解析 napi_* 符号，设备实测
 * 必然 dlopen 失败。既然已改回 dsh-subprocess-local（见 android-patch.yml 3b），
 * 这个插件**不随 APK 落位**，所以不该在交付物审计里报阻塞项 ——
 * 对不发货的文件报 BLOCKER 是噪音，而噪音会让整个审计失去可信度。
 */
const NOT_SHIPPED = ['plugins\\@dsh-android\\subprocess-rs\\'];

/** glibc 专有、bionic 不提供的符号前缀（命中即高风险）。 */
const GLIBC_ONLY = [
    '__libc_start_main', 'gnu_get_libc_version', '__errno_location',
    'secure_getenv', 'strfry', 'memfrob', '__xmknod', '__isinff',
];
/** 需要关注的符号：Android 上要么没有、要么 API level 受限。 */
const WATCH = ['statx', 'getrandom', 'pidfd_open', 'clone3', 'faccessat2', 'epoll_pwait2'];

function has(tool) {
    return fs.existsSync(tool);
}

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(node|so)$/.test(e.name)) out.push(p);
    }
    return out;
}

function readelf(args, file) {
    const r = spawnSync(READELF, [...args, file], { encoding: 'utf8', maxBuffer: 1 << 28 });
    return (r.stdout ?? '') + (r.stderr ?? '');
}

/** 解析 ELF 头里的 e_machine 与位宽。 */
function elfHeader(file) {
    const b = fs.readFileSync(file).subarray(0, 20);
    const isElf = b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
    const bits = b[4] === 2 ? 64 : 32;
    const machine = b.readUInt16LE(18);
    return { isElf, bits, machine, arch: machine === 0xb7 ? 'aarch64' : machine === 0x3e ? 'x86_64' : 'other(0x' + machine.toString(16) + ')' };
}

/**
 * 16KB 页对齐检查：Android 15+ 的 16KB 页设备要求所有 LOAD 段按 16KB 对齐。
 * @returns {{ok: boolean, detail: string}}
 */
function alignment(file) {
    const out = readelf(['-l'], file);
    // 列顺序：Type Offset VirtAddr PhysAddr FileSiz MemSiz Flg Align —— 取**最后**那个 hex。
    const aligns = [...out.matchAll(/^\s*LOAD\s+(.*)$/gm)]
        .map((m) => {
            const cols = m[1].trim().split(/\s+/);
            const last = cols[cols.length - 1];
            return /^0x[0-9a-f]+$/i.test(last) ? parseInt(last, 16) : NaN;
        })
        .filter((v) => Number.isFinite(v));
    if (aligns.length === 0) return { ok: false, detail: 'no LOAD segments parsed' };
    const min = Math.min(...aligns);
    return { ok: min >= 0x4000, detail: 'min LOAD align = 0x' + min.toString(16) + (min >= 0x4000 ? ' (>=16KB)' : ' (<16KB)') };
}

/**
 * 检查单个文件，返回风险条目数组。
 * @returns {Array<{level: string, code: string, message: string}>}
 */
function inspect(file) {
    const issues = [];
    const hdr = elfHeader(file);
    if (!hdr.isElf) return [{ level: 'INFO', code: 'not-elf', message: '不是 ELF（跳过）' }];
    if (hdr.arch !== 'aarch64') issues.push({ level: 'BLOCKER', code: 'arch', message: '架构是 ' + hdr.arch + '，设备是 arm64-v8a' });

    const dyn = readelf(['-d'], file);
    const needed = [...dyn.matchAll(/NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((m) => m[1]);
    const isNodeAddon = file.endsWith('.node');

    if (isNodeAddon && !needed.includes('libnode.so')) {
        issues.push({
            level: 'BLOCKER',
            code: 'missing-libnode-needed',
            message: 'DT_NEEDED 缺 libnode.so —— napi_* 无从解析，dlopen 会报 cannot locate symbol',
        });
    }

    const syms = readelf(['--dyn-syms'], file);
    const undef = [...syms.matchAll(/UND\s+(napi_[A-Za-z0-9_]+)/g)].map((m) => m[1]);
    if (isNodeAddon && undef.length > 0 && !needed.includes('libnode.so')) {
        issues.push({ level: 'BLOCKER', code: 'undefined-napi', message: undef.length + ' 个未解析 napi_* 符号（如 ' + [...new Set(undef)].slice(0, 3).join(', ') + '）' });
    } else if (isNodeAddon && undef.length > 0) {
        issues.push({ level: 'OK', code: 'napi-via-needed', message: undef.length + ' 个 napi_* 由 DT_NEEDED 的 libnode.so 提供' });
    }

    for (const g of GLIBC_ONLY) {
        if (new RegExp('UND\\s+' + g + '\\b').test(syms)) {
            issues.push({ level: 'BLOCKER', code: 'glibc-symbol', message: '引用 glibc 专有符号 ' + g + '（bionic 不提供）' });
        }
    }
    if (/GLIBC_\d/.test(syms)) {
        issues.push({ level: 'BLOCKER', code: 'glibc-versioned', message: '带 GLIBC_* 版本标签 —— 是桌面 Linux 产物，Android 加载不了' });
    }
    for (const w of WATCH) {
        if (new RegExp('UND\\s+' + w + '@').test(syms) || new RegExp('UND\\s+' + w + '\\b').test(syms)) {
            issues.push({ level: 'WARN', code: 'api-level', message: '使用 ' + w + '() —— Android 上 API level 受限，老设备可能缺符号' });
        }
    }

    const align = alignment(file);
    if (!align.ok) issues.push({ level: 'WARN', code: 'alignment', message: '非 16KB 对齐：' + align.detail });

    issues.push({ level: 'INFO', code: 'needed', message: 'NEEDED = ' + (needed.join(', ') || '(none)') });
    return issues;
}

/**
 * 扫 JS 源码里的硬链接调用点 —— AOSP 有 neverallow 禁止 app 建硬链接，
 * 每一处都必须已改成「独占创建」，否则会在某条用户路径上抛 EACCES。
 *
 * ⚠️ 必须同时扫 .js / .cjs / .mjs：同一份实现的打包副本常是 .cjs，
 *    只扫 .js 会漏（这个错我犯过，导致设备上继续报同一个 EACCES）。
 *
 * @param {string[]} dirs - 待扫目录。
 * @returns {Array<{file: string, patched: boolean, sites: number}>}
 */
function scanHardlinks(dirs) {
    const out = [];
    for (const dir of dirs) {
        const files = [];
        const walkAll = (d) => {
            if (!fs.existsSync(d)) return;
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) walkAll(f);
                else if (/\.(js|cjs|mjs)$/.test(e.name)) files.push(f);
            }
        };
        walkAll(dir);
        for (const file of files) {
            let src = fs.readFileSync(file, 'utf8');
            // 只认真的在调文件系统 link 的文件。
            const importsFsLink = /import\s*\{[^}]*\blink\b[^}]*\}\s*from\s*["'](node:)?fs\/promises["']/.test(src);
            const usesInternalsLink = /internals\.fs\.link\(/.test(src);
            if (!importsFsLink && !usesInternalsLink) continue;

            // ⚠️ 必须**逐调用点**判断，不能整文件一个布尔。
            // 教训：dsh-session-persistence-jsonl/lib/index.js 里有两个 link 调用点
            // （publishCurrentExclusive 与 materializePosix），第一版只要文件里出现
            // 过补丁标记就判为 OK，于是 materializePosix 那个点被静默放过 ——
            // 而用户新建会话走的正是它。
            // 做法：把辅助函数的**函数体**整体抠掉，再数剩下的 link( 就是漏网的。
            for (const helper of ['publishWithExclusiveCreate', 'linkOrExclusiveCopy']) {
                src = stripFunctionBody(src, helper);
            }

            // ⚠️ 必须解析**别名**。dsh-fs-local 写的是
            //     const linkFile = internals.linkFile ?? link;
            //     await linkFile(tempPath, absolutePath);
            // 只找 "link(" 会完全看不见它 —— 第一版就是这样给它报了 "OK"。
            const names = new Set(['link']);
            for (const m of src.matchAll(/\blink\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
            for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\blink\b\s*;/g)) names.add(m[1]);

            const sites = [];
            src.split('\n').forEach((line, i) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;  // 注释
                for (const name of names) {
                    if (new RegExp('\\b' + name + '\\s*\\(').test(line)) {
                        sites.push(i + 1);
                        return;
                    }
                }
            });
            // 文件里根本没出现过任何 link 调用的，不算问题。
            const original = fs.readFileSync(file, 'utf8');
            const everHadLink = /import\s*\{[^}]*\blink\b/.test(original)
                || /internals\.fs\.link\(/.test(original)
                || /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]*\blink\b\s*;/.test(original);
            if (!everHadLink && sites.length === 0) continue;
            out.push({ file: path.relative(ROOT, file), patched: sites.length === 0, sites, unpatchedLines: sites });
        }
    }
    return out;
}

/**
 * 从源码里抠掉某个 async 函数的整体（连函数体）。
 * @param src - 源码。
 * @param name - 函数名。
 * @returns {string} 抠掉之后的源码（找不到该函数就原样返回）。
 */
function stripFunctionBody(src, name) {
    const start = src.indexOf('async function ' + name + '(');
    if (start < 0) return src;
    // 从函数签名的第一个 { 开始做括号配对。
    let i = src.indexOf('{', start);
    if (i < 0) return src;
    let depth = 0;
    for (let j = i; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(0, start) + src.slice(j + 1);
        }
    }
    return src;
}

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS;
if (!has(READELF)) {
    console.error('找不到 llvm-readelf：' + READELF);
    process.exit(1);
}

const files = roots
    .flatMap((r) => walk(path.resolve(r)))
    .filter((f) => !NOT_SHIPPED.some((skip) => f.includes(skip)));
if (files.length < roots.flatMap((r) => walk(path.resolve(r))).length) {
    console.log('（已排除不随 APK 落位的插件：' + NOT_SHIPPED.join(', ') + '）');
}
console.log('扫描原生文件 ' + files.length + ' 个\n');

const order = { BLOCKER: 0, WARN: 1, OK: 2, INFO: 3 };
let blockers = 0;
for (const file of files) {
    const rel = path.relative(ROOT, file);
    console.log('=== ' + rel + '  (' + fs.statSync(file).size.toLocaleString() + ' 字节) ===');
    const issues = inspect(file).sort((a, b) => order[a.level] - order[b.level]);
    for (const i of issues) {
        if (i.level === 'BLOCKER') blockers += 1;
        console.log('  [' + i.level.padEnd(7) + '] ' + i.code.padEnd(24) + i.message);
    }
    console.log('');
}
// ── 硬链接调用点（Android neverallow）──────────────────────────────────────
console.log('=== 硬链接调用点（AOSP neverallow untrusted_app app_data_file:file link）===');
// 用与 ELF 扫描相同的 roots，这样传目录参数时也能对指定目录做自检。
const hardlinks = scanHardlinks(roots.map((r) => path.resolve(r)));
const unpatched = hardlinks.filter((h) => !h.patched);
for (const h of hardlinks) {
    const detail = h.patched
        ? '全部调用点已改为独占创建'
        : '**仍有裸 link() 在 L' + h.unpatchedLines.join(', L') + '** → Android 必然 EACCES';
    console.log('  [' + (h.patched ? 'OK     ' : 'BLOCKER') + '] ' + h.file + '  (' + detail + ')');
}
if (hardlinks.length === 0) console.log('  （未发现）');
blockers += unpatched.length;

console.log('');
console.log(blockers === 0 ? '结论：无阻塞项' : '结论：' + blockers + ' 个阻塞项');
process.exitCode = blockers === 0 ? 0 : 1;
