/**
 * 硬链接替代实现的语义测试。
 *
 * 被测对象是**打进运行时的那份真实代码**：从
 * dsh-session-persistence-jsonl/lib/index.js 里把 publishWithExclusiveCreate
 * 抽出来跑，而不是在这里复制一份实现 —— 否则测的是副本、不是产物。
 *
 * 断言三件事：
 *   1. link 可用时走 link（不复制字节）；
 *   2. link 报 EACCES 时回落到 O_CREAT|O_EXCL + 写内容；
 *   3. 目标已存在时 open('wx') 的 EEXIST 必须原样抛出（调用方靠它判冲突）。
 *
 * 跑法：node scripts/patch-session-link.test.mjs（或 npm run test:session-link）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCES = [
    'D:/code/dsh-android/build/runtime-stage/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
    'D:/code/dsh-android/build/runtime-stage/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
];

let passed = 0;
const failures = [];
let chain = Promise.resolve();

function test(name, fn) {
    chain = chain.then(fn).then(
        () => { passed += 1; console.log('  ok  ' + name); },
        (error) => {
            failures.push(name);
            console.log('FAIL  ' + name + '\n      ' + String(error && error.message).split('\n')[0]);
        },
    );
}

// ── 从真实产物里抠出被测函数 ────────────────────────────────────────────────
// 两个文件都必须打上补丁 —— 只打一个正是我犯过的错。
const helpers = SOURCES.map((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf('async function publishWithExclusiveCreate');
    assert.ok(start >= 0, file + '：找不到 publishWithExclusiveCreate —— 补丁漏了这个文件？');
    // 下一个顶层 async function 就是本函数的结尾 —— 不能写死成 publishCurrentExclusive，
    // 因为 index.js 现在在它们之间还插了 linkOrExclusiveCopy。
    const end = source.indexOf('\nasync function ', start + 1);
    assert.ok(end > start, file + '：找不到函数结尾');
    return { file, fn: new Function('return (' + source.slice(start, end) + ')')() };
});
// 两份实现内容必须一致（同一份源码的两个副本）。
assert.equal(helpers[0].fn.toString(), helpers[1].fn.toString(), '两份副本实现不一致');
const publishWithExclusiveCreate = helpers[0].fn;

/**
 * 造一个假 internals。
 * @param options.linkError - link 要抛的错误码，null 表示成功。
 */
function makeInternals(options = {}) {
    const calls = { link: 0, open: 0, wrote: null };
    const bytes = Buffer.from('STAGED-CONTENT');
    return {
        calls,
        internals: {
            fs: {
                link: async () => {
                    calls.link += 1;
                    if (options.linkError) throw Object.assign(new Error('link failed'), { code: options.linkError });
                },
                readFile: async () => bytes,
                open: async (p, flags) => {
                    calls.open += 1;
                    assert.equal(flags, 'wx', 'must open exclusively');
                    if (options.targetExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
                    return { writeFile: async (data) => { calls.wrote = data; }, close: async () => { calls.closed = true; } };
                },
            },
        },
    };
}

test('link 可用时走 link，不复制字节', async () => {
    const h = makeInternals();
    await publishWithExclusiveCreate('/s/a.tmp', '/s/a', h.internals);
    assert.equal(h.calls.link, 1);
    assert.equal(h.calls.open, 0, 'link 成功就不该再 open');
});

test('link 报 EACCES 时回落为独占创建 + 写内容', async () => {
    const h = makeInternals({ linkError: 'EACCES' });
    await publishWithExclusiveCreate('/s/a.tmp', '/s/a', h.internals);
    assert.equal(h.calls.open, 1);
    assert.equal(h.calls.wrote.toString(), 'STAGED-CONTENT');
    assert.equal(h.calls.closed, true, '句柄必须关闭');
});

test('EOPNOTSUPP 同样回落（不支持硬链接的文件系统）', async () => {
    const h = makeInternals({ linkError: 'EOPNOTSUPP' });
    await publishWithExclusiveCreate('/s/a.tmp', '/s/a', h.internals);
    assert.equal(h.calls.open, 1);
});

test('目标已存在时 EEXIST 必须原样抛出（调用方靠它判冲突）', async () => {
    const h = makeInternals({ linkError: 'EACCES', targetExists: true });
    await assert.rejects(
        () => publishWithExclusiveCreate('/s/a.tmp', '/s/a', h.internals),
        (error) => { assert.equal(error.code, 'EEXIST'); return true; },
    );
});

test('其它 link 错误（如 ENOSPC）不回落，直接抛', async () => {
    const h = makeInternals({ linkError: 'ENOSPC' });
    await assert.rejects(
        () => publishWithExclusiveCreate('/s/a.tmp', '/s/a', h.internals),
        (error) => { assert.equal(error.code, 'ENOSPC'); return true; },
    );
    assert.equal(h.calls.open, 0, '不该在真正的错误上继续尝试');
});

/**
 * 回归测试：运行时里**不能有任何**未被替换的 link 调用点。
 *
 * 这是被真实事故逼出来的检查。当时的漏洞有两层：
 *   1. dsh-session-persistence-jsonl/lib/index.js 有**两个** link 调用点，
 *      只改了 publishCurrentExclusive，漏了 materializePosix（首次建会话走的正是它）；
 *   2. dsh-fs-local 通过**别名**调用 —— `const linkFile = internals.linkFile ?? link`
 *      然后 `await linkFile(...)`，只 grep "link(" 完全看不见。
 * 所以这里把「抠掉已替换的辅助函数后，还剩多少 link 调用」当作断言，
 * 而不是只检查「文件里有没有补丁标记」。
 */
test('运行时里没有未替换的硬链接调用点', async () => {
    const root = 'D:/code/dsh-android/build/runtime-stage/node_modules/@deepseek-ai';
    const targets = [
        'dsh-session-persistence-jsonl/lib/index.js',
        'dsh-session-persistence-jsonl/lib/worker.cjs',
        'dsh-fs-local/lib/index.js',
        'dsh-attachment-local/lib/index.js',
    ];
    for (const rel of targets) {
        const file = path.join(root, rel);
        assert.ok(fs.existsSync(file), rel + ' 不存在');
        let src = fs.readFileSync(file, 'utf8');
        // 抠掉已替换的辅助函数整体（含函数体）。
        for (const helper of ['publishWithExclusiveCreate', 'linkOrExclusiveCopy']) {
            const start = src.indexOf('async function ' + helper + '(');
            if (start < 0) continue;
            const open = src.indexOf('{', start);
            let depth = 0;
            for (let j = open; j < src.length; j += 1) {
                if (src[j] === '{') depth += 1;
                else if (src[j] === '}') {
                    depth -= 1;
                    if (depth === 0) { src = src.slice(0, start) + src.slice(j + 1); break; }
                }
            }
        }
        // 解析 link 的别名（`= ... link;` 与 `link as X`）。
        const names = new Set(['link']);
        for (const m of src.matchAll(/\blink\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
        for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\blink\b\s*;/g)) names.add(m[1]);
        const leaked = [];
        src.split('\n').forEach((line, i) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
            for (const name of names) {
                if (new RegExp('\\b' + name + '\\s*\\(').test(line)) { leaked.push(rel + ':' + (i + 1)); return; }
            }
        });
        assert.deepEqual(leaked, [], rel + ' 仍有未替换的 link 调用点');
    }
});

await chain;
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) process.exitCode = 1;
