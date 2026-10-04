#!/usr/bin/env node
/**
 * 把运行时里所有「用硬链接做原子发布」的地方改成「独占创建 + 写内容」。
 *
 * ── 为什么 ──────────────────────────────────────────────────────────────────
 * AOSP SELinux 有一条 neverallow：
 *
 *   # Do not allow untrusted_app to hard link to any files.
 *   neverallow untrusted_app app_data_file:file link;
 *
 * app 进程**永远**不能在私有目录建硬链接（与权限、targetSdk 无关）。实机症状：
 *
 *   EACCES: permission denied, link '.../session.v4.jsonl.zstd.<hash>.tmp'
 *     -> '.../session.v4.jsonl.zstd'
 *
 * ── 改法 ────────────────────────────────────────────────────────────────────
 * link() 在这里是「独占发布」原语：目标已存在时报 EEXIST，调用方据此判冲突。
 * 替换实现必须保住这个语义 —— 用 O_CREAT|O_EXCL 打开目标，创建动作本身原子，
 * 输的一方同样拿到 EEXIST。先试 link（支持的平台更省），只在明确不支持时回落。
 *
 * ── ⚠️ 血泪教训：必须**逐调用点**统计，不能整文件一个布尔 ────────────────────
 * 第一版只在文件里找「有没有补丁标记」，于是：
 * dsh-session-persistence-jsonl/lib/index.js 里有**两个** link 调用点 ——
 *   · L2033 publishCurrentExclusive —— 后续世代发布（改过了）
 *   · L3167 materializePosix        —— **首次建会话**时发布（漏了）
 * 整个文件被判为「已打补丁」，第二个点被静默放过；而用户新建会话走的正是
 * materializePosix，所以错误一直复现。
 * 现在 EDITS 逐个列出调用点原文，**找不到就报错退出**。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NM = 'build/runtime-stage/node_modules';

/** 会话持久化：publishCurrentExclusive 用 internals.fs 抽象（测试接缝）。 */
const SESSION_INTERNALS_HELPER = [
    '/**',
    ' * Android 适配：app 进程被 SELinux neverallow 禁止对 app_data_file 建硬链接',
    ' * （AOSP 原文：Do not allow untrusted_app to hard link to any files）。',
    ' * 保住 link() 的独占语义：目标已存在 -> EEXIST（由 O_CREAT|O_EXCL 天然给出）。',
    ' */',
    'async function publishWithExclusiveCreate(staged, currentPath, internals) {',
    '    try {',
    '        await internals.fs.link(staged, currentPath);',
    '        return;',
    '    } catch (error) {',
    '        const code = error?.code;',
    '        if (code !== "EACCES" && code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "ENOTSUP") throw error;',
    '    }',
    '    const handle = await internals.fs.open(currentPath, "wx");',
    '    try {',
    '        const bytes = await internals.fs.readFile(staged);',
    '        await handle.writeFile(bytes);',
    '    } finally {',
    '        await handle.close();',
    '    }',
    '}',
    '',
    '',
].join('\n');

/** 会话持久化：materializePosix 用模块顶层 import 的 link/open/readFile。 */
const SESSION_DIRECT_HELPER = [
    '/**',
    ' * 同 publishWithExclusiveCreate，但用模块顶层 import 的 fs 函数 ——',
    ' * 首次建会话走 materializePosix，那里是裸 import 的 link()。',
    ' */',
    'async function linkOrExclusiveCopy(source, target) {',
    '    try {',
    '        await link(source, target);',
    '        return;',
    '    } catch (error) {',
    '        const code = error?.code;',
    '        if (code !== "EACCES" && code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "ENOTSUP") throw error;',
    '    }',
    '    const handle = await open(target, "wx");',
    '    try {',
    '        await handle.writeFile(await readFile(source));',
    '    } finally {',
    '        await handle.close();',
    '    }',
    '}',
    '',
    '',
].join('\n');

/** 附件存储：同样用顶层 import 的 fs 函数。 */
const ATTACHMENT_HELPER = [
    '/**',
    ' * Android 适配：同 linkOrExclusiveCopy。附件存储的两处发布点',
    ' * （新建对象、给已有对象加别名），调用方的 EEXIST 冲突判定不受影响。',
    ' */',
    'async function linkOrExclusiveCopy(source, target) {',
    '    try {',
    '        await link(source, target);',
    '        return;',
    '    } catch (error) {',
    '        const code = error?.code;',
    '        if (code !== "EACCES" && code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "ENOTSUP") throw error;',
    '    }',
    '    const handle = await open(target, "wx");',
    '    try {',
    '        await handle.writeFile(await readFile(source));',
    '    } finally {',
    '        await handle.close();',
    '    }',
    '}',
    '',
    '',
].join('\n');

/**
 * 文件写入（dsh-fs-local）：那里把 link 取成 `internals.linkFile ?? link` 别名，
 * 所以辅助函数要**接收 link 函数本身**，保住测试接缝。
 */
const FS_LOCAL_HELPER = [
    '/**',
    ' * Android 适配：app 进程被 SELinux neverallow 禁止对 app_data_file 建硬链接。',
    ' * 把 linkFn 作为参数传入是为了保住 internals.linkFile 这个测试接缝。',
    ' * 提交用 O_CREAT|O_EXCL，创建动作本身原子 —— 并发创建者一样拿到 EEXIST，',
    ' * 调用方（throwGuardedCreateFailure）的冲突判定不受影响。',
    ' */',
    'async function linkOrExclusiveCopy(linkFn, source, target) {',
    '    try {',
    '        await linkFn(source, target);',
    '        return;',
    '    } catch (error) {',
    '        const code = error?.code;',
    '        if (code !== "EACCES" && code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "ENOTSUP") throw error;',
    '    }',
    '    const handle = await open(target, "wx");',
    '    try {',
    '        await handle.writeFile(await readFile(source));',
    '    } finally {',
    '        await handle.close();',
    '    }',
    '}',
    '',
    '',
].join('\n');

/** 逐文件、逐调用点的清单。edit 找不到原文就报错退出，绝不静默跳过。 */
const JOBS = [
    {
        file: '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
        helper: SESSION_INTERNALS_HELPER + SESSION_DIRECT_HELPER,
        anchor: 'async function publishCurrentExclusive(staged, currentPath, internals) {',
        edits: [
            [
                'await internals.fs.link(staged, currentPath);',
                'await publishWithExclusiveCreate(staged, currentPath, internals);',
            ],
            [
                'await link(tmp, finalPath);',
                'await linkOrExclusiveCopy(tmp, finalPath);',
            ],
        ],
    },
    {
        file: '@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
        helper: SESSION_INTERNALS_HELPER,
        anchor: 'async function publishCurrentExclusive(staged, currentPath, internals) {',
        edits: [
            [
                'await internals.fs.link(staged, currentPath);',
                'await publishWithExclusiveCreate(staged, currentPath, internals);',
            ],
        ],
    },
    {
        // ⚠️ 这个点是**别名调用**：文件里写的是 `await linkFile(...)`，`linkFile`
        //    来自 `internals.linkFile ?? link`。所以 grep "\\blink\\s*\\(" 抓不到它 ——
        //    第一版扫描器就这样放过了这里，还报了「OK」。检测必须解析别名。
        file: '@deepseek-ai/dsh-fs-local/lib/index.js',
        helper: FS_LOCAL_HELPER,
        anchor: 'async function writeFileAtomic(absolutePath, content, mode, signal, internals = {}, createIfAbsent) {',
        edits: [
            [
                'await linkFile(tempPath, absolutePath);',
                'await linkOrExclusiveCopy(linkFile, tempPath, absolutePath);',
            ],
        ],
    },
    {
        file: '@deepseek-ai/dsh-attachment-local/lib/index.js',
        helper: ATTACHMENT_HELPER,
        anchor: 'async function publishImmutableAlias(',
        edits: [
            ['await link(source, target);', 'await linkOrExclusiveCopy(source, target);'],
            ['await link(staged.path, target);', 'await linkOrExclusiveCopy(staged.path, target);'],
        ],
    },
];

let changed = 0;

for (const job of JOBS) {
    const target = path.join(ROOT, NM, job.file);
    if (!fs.existsSync(target)) {
        console.error('[hardlink] 找不到 ' + job.file + ' —— 先跑 pack-runtime 生成 runtime-stage');
        process.exit(1);
    }
    let source = fs.readFileSync(target, 'utf8');
    // 用辅助函数的首个独特标识判断是否已打过补丁。
    const marker = job.helper.includes('publishWithExclusiveCreate')
        ? 'async function publishWithExclusiveCreate'
        : 'async function linkOrExclusiveCopy';
    if (source.includes(marker)) {
        console.log('[hardlink] ' + job.file + '：已打过补丁，跳过');
        continue;
    }
    // ⚠️ 顺序：先替换调用点，再插入辅助函数。反过来会把辅助函数体内那句 link
    //    也一起换掉 —— 变成自己调自己，栈溢出。实测踩过。
    for (const [from, to] of job.edits) {
        if (!source.includes(from)) {
            console.error('[hardlink] ' + job.file + '：未命中调用点 "' + from + '"');
            console.error('           dsh 升级后可能改了实现。请人工核对该文件**全部** link 调用点');
            console.error('           （grep "\\blink\\s*\\("），再更新本脚本。');
            process.exit(1);
        }
        source = source.replace(from, to);
    }
    if (!source.includes(job.anchor)) {
        console.error('[hardlink] ' + job.file + '：找不到插入锚点 ' + job.anchor);
        process.exit(1);
    }
    source = source.replace(job.anchor, job.helper + job.anchor);
    fs.writeFileSync(target, source);
    console.log('[hardlink] ' + job.file + '：已改为独占创建（' + job.edits.length + ' 处调用）');
    changed += 1;
}

console.log('[hardlink] 完成：改动 ' + changed + ' 个文件');
