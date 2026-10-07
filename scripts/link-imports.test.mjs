/**
 * 静态一致性检查：代码里**引用**的标识符必须**导入**了。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────────────────────
 * 加跨端共享模型列表时写了 `conn.peerMethods.includes(LIST_ADVERTISED)`，
 * 但 import 那行忘了带 `LIST_ADVERTISED`。结果是那个标识符是 `undefined`，
 * `includes(undefined)` **恒为 false** —— 于是：
 *
 *   · 语法完全合法，node --check 通过；
 *   · 单元测试全绿（没人测到那个分支）；
 *   · 连接正常、功能正常，只有「桌面的模型列表」永远不出现。
 *
 * 这类错的共同点：**静默**。ESM 对未导入的标识符不做前置检查（不像 TS 会
 * 编译期报错），所以只能靠工具查。
 *
 * ── 查什么 ──────────────────────────────────────────────────────────────────
 *   1. 从 import { … } 里收集实际导入的名字；
 *   2. 在 import 之外找出形如 XXX_YYY（大写下划线，模块级常量/函数）的引用；
 *   3. 引用了但没导入 → 报出来。
 *
 * 不查的：普通局部变量、函数参数、对象属性（`foo.LIST_BAR`）—— 那些不是
 * 模块级标识符，靠正则分不准，误报会盖掉真问题。
 *
 * 跑法：node scripts/link-imports.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 要检查的插件文件（两端 + 规范源 —— 规范源改了，另两处是 sync 过去的）。 */
const FILES = [
    'plugins/@dsh-android/link/lib/index.js',
    'desktop-plugins/@dsh-desktop/link/lib/index.js',
    'packages/dsh-link-protocol/lib/llmrelay.js',
    'packages/dsh-link-protocol/lib/mesh-manager.js',
    'packages/dsh-link-protocol/lib/protocol.js',
];

/**
 * 去掉 import 区与注释，剩下的才是「真正的代码」。
 *
 * 不去注释的话，注释里写的常量名（这段代码里全是 ⚠️ 注释举例）会被当成引用，
 * 误报一堆。
 */
function codeOnly(src) {
    return src
        // 行注释
        .replace(/^\s*\/\/.*$/gm, '')
        // 块注释（含 /** */ 与 /* */）
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // 字符串与模板字符串（简化：处理常见的引号配对）
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** 收集从 import { … } 里导入的标识符。 */
function importedNames(src) {
    const names = new Set();
    const re = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
    let m;
    while ((m = re.exec(src))) {
        for (const part of m[1].split(',')) {
            const n = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (n) names.add(n);
        }
    }
    return names;
}

/**
 * 找出「模块级常量」形态的引用：全大写、可能带下划线。
 *
 * 只认这个形态是有意的 —— 它正是最容易「用了忘导入」的一类（都是协议常量），
 * 而普通小写变量（peerRegistry、state 等）是闭包里的，import 缺失会直接
 * ReferenceError 而不是静默失效。
 */
function constReferences(src) {
    const code = codeOnly(src);
    const refs = new Map();
    const re = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
    let m;
    while ((m = re.exec(code))) {
        // 排除定义处（const FOO = …）与对象属性（.FOO_BAR）
        const before = code.slice(Math.max(0, m.index - 30), m.index);
        if (/const\s+$/.test(before)) continue;
        if (/\.\s*$/.test(before)) continue;
        // 排除 import 语句里的（虽然 codeOnly 保留了 import 行）
        const lineStart = code.lastIndexOf('\n', m.index) + 1;
        if (/^\s*(import|export)\s/.test(code.slice(lineStart, m.index))) continue;
        if (!refs.has(m[1])) refs.set(m[1], m.index);
    }
    return refs;
}

/**
 * 同文件内定义的常量（const FOO = / const FOO =' 等）。
 *
 * 少了这一步会满屏误报：MOBILE_CAPS、DESKTOP_CAPS、CODE_TTL_MS 全都是
 * 本文件里定义的，根本不需要 import。误报一多，这个检查就没人看了 ——
 * 而一个天天误报的检查等于没有检查。
 */
function locallyDefinedNames(src) {
    const names = new Set();
    const code = codeOnly(src);
    const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    let m;
    while ((m = re.exec(code))) names.add(m[1]);
    // export const FOO = … 的上面那个 re 已经覆盖（const 前有 export，
    // 正则里 \b 之后直接就是 const），但保险起见再收一遍 function 声明。
    const fre = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = fre.exec(code))) names.add(m[1]);
    return names;
}

test('代码里引用的模块级常量都导入了吗', () => {
    const problems = [];
    for (const rel of FILES) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const imported = importedNames(src);
        const local = locallyDefinedNames(src);
        for (const [name, at] of constReferences(src)) {
            // 本文件里定义的不算「未导入」—— 那才是真正的误报来源。
            if (local.has(name)) continue;
            if (!imported.has(name)) {
                const line = src.slice(0, at).split('\n').length;
                problems.push(`${rel}:${line}  引用了 ${name}，但 import 里没有`);
            }
        }
    }
    // 一次全报出来，而不是遇到第一个就停 —— 逐个改容易漏。
    assert.deepEqual(problems, [], '未导入的引用：\n  ' + problems.join('\n  '));
});

test('两端插件都从同一个规范源导入了 llmrelay 的同名常量', () => {
    // llmrelay.js 的导出清单（协议常量，两端必须一致 ——
    // 一端漏导入的表现是「那个功能永远不触发」，静默）。
    const REQUIRED = [
        'RELAY_METHOD', 'RELAY_ADVERTISED', 'RELAY_POLICY',
        'REMOTE_PROVIDER', 'REMOTE_PROVIDER_LABEL',
        'LIST_METHOD', 'LIST_ADVERTISED',
    ];
    const problems = [];
    for (const rel of [
        'plugins/@dsh-android/link/lib/index.js',
        'desktop-plugins/@dsh-desktop/link/lib/index.js',
    ]) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const imported = importedNames(src);
        const missing = REQUIRED.filter((n) => !imported.has(n));
        if (missing.length) problems.push(`${rel} 缺: ${missing.join(', ')}`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
});