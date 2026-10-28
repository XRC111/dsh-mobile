/**
 * 运行时 API 表面：某个包在当前宿主里「是否可见」「导出了哪些符号」。
 *
 * ── 为什么不用静态差分表判可见性 ────────────────────────────────────────────
 * 一开始的想法是「对比 0.1.5 与 0.2.1 的包清单，缺了的就判死」。实测不成立：
 *
 *   · `@deepseek-ai/dsh-webhook` 在 0.2.0 的顶层 node_modules 里有、0.2.1 没有，
 *     但它实际是被 dsh 的 optional bundle 机制移走了，不是「坏了」；
 *   · 反过来，`@deepseek-ai/dsh-client-store` 三个版本都不在顶层 node_modules ——
 *     它是**浏览器侧**模块，由宿主模块表提供，用 node 的解析规则永远查不到。
 *
 * 所以判可见性必须走 Node 自己的解析算法（createRequire），而不是对比目录清单。
 * 目录里有没有，跟插件 import 的时候能不能解析到，是两件事。
 *
 * ── 导出符号怎么读 ─────────────────────────────────────────────────────────
 * 不做完整 AST：只需要「这个名字在不在导出的集合里」。做法是读入口文件，扫
 *   export { a, b as c } / export function f / export const x / exports.foo =
 * 三类语句。压缩过的产物（>4MB）直接标 unreadable —— 那种文件里符号可能被
 * 改成短名，扫出来的结果不可信，宁可判「不知道」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 超过这个大小的入口文件视为压缩产物，不扫符号。 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/** 从 package.json 的 exports 里挑一个能当入口的路径。 */
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
        // `.` 优先；没有就退而取第一个非通配子路径 —— 有些包（如 dsh-tool-cordis）
        // 只把能力挂在子路径上，根入口是空的。
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

/**
 * 扫一个 JS 文件的导出符号。
 * @returns {Set<string>|null} null = 文件不可读或不可信
 */
function symbolsOf(file) {
    let text;
    try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_SCAN_BYTES) return null;
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
    const names = new Set();

    // export { a, b as c } / export { a } from './x.js'
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const item = part.trim();
            if (item === '') continue;
            const as = item.split(/\s+as\s+/);
            const name = (as[1] ?? as[0]).trim().replace(/^type\s+/, '');
            if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
    }
    // export function f / export class C / export const x
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(m[1]);
    }
    // export * from './x.js' —— 无法静态展开，交给调用方按「不可判定」处理
    if (/export\s+\*\s+from/.test(text)) return null;

    // CJS：exports.foo = / exports['foo'] =
    for (const m of text.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
    for (const m of text.matchAll(/^exports\[["']([^"']+)["']\]\s*=/gm)) names.add(m[1]);

    return names;
}

/**
 * 建一个「这个宿主能解析到什么」的查询器。
 *
 * @param {object} options
 * @param {string[]} options.resolveFrom 解析起点（目录或文件路径），按顺序尝试。
 *   传 dsh 自己的 package.json 最准 —— 插件解析 peer 依赖时，Node 实际就是
 *   从 dsh 所在的位置往上找 node_modules。
 * @param {Record<string, string>} [options.aliases] 包名别名（旧名 → 新名），
 *   用于「包改名了但功能还在」的情况，例如 dsh-settings-file → dsh-settings。
 * @returns {{probe:(pkg:string)=>{package:string,visible:boolean,path?:string,symbols?:Set<string>|null,error?:string}}}
 */
export function createSurface({ resolveFrom = [], aliases = {} } = {}) {
    const requires = resolveFrom.map((p) => {
        try {
            return createRequire(path.resolve(p));
        } catch {
            return null;
        }
    }).filter(Boolean);
    if (requires.length === 0) throw new Error('createSurface 需要至少一个可用的 resolveFrom 路径');

    const cache = new Map();

    function probe(pkg) {
        if (cache.has(pkg)) return cache.get(pkg);
        let result;
        for (const req of requires) {
            try {
                const entry = req.resolve(pkg);
                // 入口可能是 .js/.cjs/.mjs；取它所在的包根目录
                const dir = findPackageRoot(entry);
                const main = dir === null ? entry : path.join(dir, entryOf(dir) ?? path.basename(entry));
                const symbols = symbolsOf(main);
                result = { package: pkg, visible: true, path: entry, symbols };
                break;
            } catch (error) {
                result = { package: pkg, visible: false, error: String(error?.code ?? error?.message ?? error) };
            }
        }
        // 原包名解析不到时试别名：改名的包对旧插件来说仍然是「能跑」的，
        // 只是 import 的名字不一样 —— 那种情况需要插件侧改代码，所以这里
        // **不算可见**，只把替代包名带回去给调用方生成建议。
        if (result !== undefined && !result.visible && aliases[pkg] !== undefined) {
            result = { ...result, renamedTo: aliases[pkg] };
        }
        cache.set(pkg, result);
        return result;
    }

    return { probe };
}

/** 从入口文件往上找带 package.json 的目录。 */
function findPackageRoot(file) {
    let dir = path.dirname(file);
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** 直接给一个包目录，读它的根入口符号（用于离线分析，比如构建期扫自己打的包）。 */
export function symbolsOfPackage(pkgDir) {
    const entry = entryOf(pkgDir);
    if (entry === null) return null;
    return symbolsOf(path.join(pkgDir, entry));
}
