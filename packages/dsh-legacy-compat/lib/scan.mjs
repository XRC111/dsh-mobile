/**
 * 插件源码扫描：它到底 import 了宿主的哪些包、哪些符号。
 *
 * ── 为什么要扫源码，而不是只看 package.json ─────────────────────────────────
 * `peerDependencies` 是作者的**声明**，不是事实。实测两类偏差都很常见：
 *   · 声明 `^0.1.2` 但只用了 `ctx.effect` 这类从未变过的 API（dsh-dracula-theme）；
 *   · 声明 `>=0.1.0 <0.3.0`（宽到永远满足）却在代码里 import 了 0.2.1 已移除的包。
 * 兼容层要回答的是「这段代码在新宿主上能不能跑」，那就只能看它实际用了什么。
 *
 * ── 支持的写法 ─────────────────────────────────────────────────────────────
 *   import { a, b as c } from '@deepseek-ai/x'     → 具名符号 a、c
 *   import d from '@deepseek-ai/x'                  → 默认导入（不做符号校验）
 *   import * as ns from '@deepseek-ai/x'            → 命名空间（不做符号校验）
 *   import '@deepseek-ai/x'                         → 纯副作用
 *   export { a } from '@deepseek-ai/x'              → 具名符号
 *   require('@deepseek-ai/x') / import('@deepseek-ai/x')  → 不做符号校验
 *
 * 扫描是**保守**的：只对 `import { ... }` / `export { ... } from` 这类能确定
 * 名字的做符号校验，其余只校验「包是否还在」。误判成「通过」的代价是用户装了
 * 一个会报错的插件（有日志可查）；误判成「不通过」的代价是用户装不上能用的插件。
 * 两者都要避免，但前者可恢复、后者不可，所以宁可偏保守。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 只关心宿主提供的包；其余包由插件自己的 node_modules 负责，不属兼容层范围。 */
const HOST_SCOPE = /^@deepseek-ai\/(?:dsh(?:-|$)|cordis(?:-|$))/;

/** 不扫的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'coverage', 'dist-map']);

const SOURCE_EXT = /\.(?:js|mjs|cjs|jsx)$/;

/** 归一化路径分隔符。 */
const posix = (p) => p.split(path.sep).join('/');

/**
 * 判断一个文件属于哪一侧。
 *
 * ⚠️ 这个区分不是洁癖，是判对的前提：客户端代码里的
 *    `require('@deepseek-ai/dsh-client-store')` 由**浏览器侧模块表**解析，
 *    Node 的 resolve 永远查不到（实测 dsh-client-store 在 0.1.5 / 0.2.1 的
 *    node_modules 里都不存在）。拿 Node 的可见性去判它，会把一个正常的
 *    主题插件判成「缺包，不能运行」—— 完全误报。
 *
 * 识别规则（按可靠度排序）：
 *   1. package.json 的 `dsh.client` 声明 + exports 里 `./client` 指向的文件；
 *   2. 路径里带 `client` 目录段或文件名含 `client` 的；
 *   3. 其余算宿主侧。
 *
 * @param {string} rel 相对插件根的 POSIX 路径
 * @param {Set<string>} clientEntries 由 manifest 解析出的客户端入口（相对路径）
 */
function sideOf(rel, clientEntries) {
    if (clientEntries.has(rel)) return 'client';
    const segments = rel.split('/');
    if (segments.includes('client') || segments.includes('client-ui')) return 'client';
    const file = segments.at(-1) ?? '';
    if (/(?:^|\.)client\.(?:js|mjs|cjs|jsx)$/.test(file)) return 'client';
    return 'host';
}

/** 从 manifest 里解析客户端入口文件（相对插件根的 POSIX 路径）。 */
function clientEntriesOf(dir) {
    const entries = new Set();
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
        return entries;
    }
    const client = manifest?.dsh?.client;
    if (client === undefined || client === null) return entries;
    const pick = (v) => (typeof v === 'string' ? v : (v?.default ?? v?.import ?? v?.require));
    const exportsMap = manifest.exports;
    if (exportsMap !== null && typeof exportsMap === 'object') {
        const sub = pick(exportsMap['./client']);
        if (typeof sub === 'string') entries.add(posix(path.normalize(sub.replace(/^\.\//, ''))));
        const subEntry = pick(exportsMap['./client/index']);
        if (typeof subEntry === 'string') entries.add(posix(path.normalize(subEntry.replace(/^\.\//, ''))));
    }
    // 有些插件直接把入口写在 dsh.client.entry / dsh.client.main 里。
    for (const key of ['entry', 'main', 'file']) {
        const value = client?.[key];
        if (typeof value === 'string') entries.add(posix(path.normalize(value.replace(/^\.\//, ''))));
    }
    return entries;
}

/**
 * 剥掉注释。
 *
 * ⚠️ 必须做：真实代码里 `import ... from './x.js'` 会出现在**注释**中
 *    （比如打印 ERR_MODULE_NOT_FOUND 的报错样例）。不剥就会把注释里的示例
 *    当成真导入，判出一个不存在的依赖。
 *
 * 只处理 `/* *\/` 与行首/空白后的 `//`；不碰字符串内部的 `//`（如 URL），
 * 因为那会把 `'https://x'` 截断成 `'https:`，反而制造噪声。
 */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[\s;{}()])\/\/[^\n]*/g, '$1');
}

/** 收集一个文件里的宿主依赖。 */
function scanFile(file) {
    let text;
    try {
        text = stripComments(fs.readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
    const found = [];
    const push = (pkg, symbols) => {
        if (!HOST_SCOPE.test(pkg)) return;
        found.push({ package: pkg, symbols });
    };

    // import { a, b as c } from 'pkg'
    // export { a } from 'pkg'
    for (const m of text.matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        const symbols = m[1]
            .split(',')
            .map((s) => s.trim().split(/\s+as\s+/)[1] ?? s.trim().split(/\s+as\s+/)[0])
            .map((s) => s.trim().replace(/^type\s+/, ''))
            .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
        push(m[2], symbols);
    }
    // import d from 'pkg' / import * as ns from 'pkg'
    for (const m of text.matchAll(/import\s+(?:\*\s*as\s+[\w$]+|[\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g)) {
        push(m[1], null);
    }
    // import 'pkg'
    for (const m of text.matchAll(/import\s*['"]([^'"]+)['"]/g)) push(m[1], null);
    // require('pkg') / import('pkg')
    for (const m of text.matchAll(/(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], null);

    return found;
}

/**
 * 扫一个插件目录。
 *
 * @param {string} dir 插件根目录
 * @returns {{hostImports: Array<{package:string, symbols:string[]|null, files:string[]}>,
 *            clientImports: Array<{package:string, symbols:string[]|null, files:string[]}>,
 *            clientInjects: string[]}}
 *   `hostImports` 可以用 Node 的解析结果校验；`clientImports` 不行（见 sideOf 的说明），
 *   调用方应把后者当作「未校验」，而不是「通过」或「失败」。
 */
export function scanPluginDir(dir) {
    const clientEntries = clientEntriesOf(dir);
    const host = new Map();
    const client = new Map();

    const record = (bucket, hit, rel) => {
        const item = bucket.get(hit.package) ?? { package: hit.package, symbols: new Set(), namespace: false, files: [] };
        if (hit.symbols === null) item.namespace = true;
        else for (const s of hit.symbols) item.symbols.add(s);
        if (!item.files.includes(rel)) item.files.push(rel);
        bucket.set(hit.package, item);
    };

    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(full);
                continue;
            }
            if (!SOURCE_EXT.test(entry.name)) continue;
            const rel = posix(path.relative(dir, full));
            const bucket = sideOf(rel, clientEntries) === 'client' ? client : host;
            for (const hit of scanFile(full)) record(bucket, hit, rel);
        }
    };
    walk(dir);

    // 客户端依赖不在源码里 import（浏览器侧由宿主模块表解析），
    // 只能从 package.json 的 dsh.client.inject 读。
    let clientInjects = [];
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const inject = manifest?.dsh?.client?.inject;
        if (Array.isArray(inject)) clientInjects = inject.filter((x) => typeof x === 'string');
    } catch { /* 没有 manifest 就当没有客户端依赖 */ }

    const finish = (bucket) => [...bucket.values()].map((item) => ({
        package: item.package,
        // namespace=true 表示存在命名空间/默认导入：符号集合不完整，不能据此判缺失。
        symbols: item.namespace ? null : [...item.symbols].sort(),
        files: item.files.sort(),
    }));

    return {
        hostImports: finish(host),
        clientImports: finish(client),
        clientInjects,
    };
}
