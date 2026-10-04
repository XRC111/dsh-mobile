#!/usr/bin/env node
/**
 * 原生插件加载自检 —— 在 launcher 里跑，把结论写进 dsh.log。
 *
 * 为什么放在 launcher 而不是做成插件工具：
 *   会话持久化要 flock，flock 要加载 system.node，加载失败 → 会话起不来 →
 *   工具根本调不到。也就是说「能跑工具」和「需要诊断」是互斥的。
 *   而 launcher 在 dsh 之前、同一个 Node 进程里跑，用的是**完全相同**的
 *   dlopen 机制，所以在这里测出来的结论对 dsh 同样成立。
 *
 * 输出四项：
 *   1. libnode 映射：/proc/self/maps 里 libnode.so 到底加载了没有、在哪；
 *   2. 每个 .node 的实际 dlopen 结果（成功 / 确切错误码与首行消息）；
 *   3. napi 符号是否能在进程内解析（用 dlopen 结果间接判断）；
 *   4. 进程与路径事实（platform/arch/execPath/TMPDIR）。
 *
 * 只读，失败不影响启动。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 从 /proc/self/maps 里挑出与 libnode 有关的映射。
 *
 * ⚠️ 不要用「以 libnode.so 结尾」这种严格匹配。Android 可以直接从 APK 映射
 * native 库，条目可能形如 \`.../base.apk\` 或 \`.../base.apk!/lib/arm64-v8a/libnode.so\`，
 * 也可能带 \` (deleted)\` 后缀。第一版用严格结尾匹配，设备上打出
 * "(NONE — libnode 未加载?)"，而 node 明明在跑 —— 错的是匹配方式，不是库没加载。
 * 现在凡是行内出现 libnode 或 .apk 的映射都原样带回来。
 *
 * @returns {string[]} 原始映射行（最多 12 条）。
 */
function libnodeMaps() {
    try {
        const text = fs.readFileSync('/proc/self/maps', 'utf8');
        const found = new Set();
        for (const line of text.split('\n')) {
            if (!/libnode|\.apk/i.test(line)) continue;
            const slash = line.indexOf('/');
            found.add(slash < 0 ? line.trim() : line.slice(slash).trim());
        }
        return [...found].slice(0, 12);
    } catch (error) {
        return ['(read /proc/self/maps failed: ' + (error && error.message) + ')'];
    }
}

/**
 * 试加载一个原生模块，返回结果摘要。
 * @param {string} specifier - 裸包名或绝对路径。
 * @param {string} [from] - 用于解析裸包名的基准文件路径。
 * @returns {string} 一行结论。
 */
function tryLoad(specifier, from) {
    try {
        const req = from ? require('node:module').createRequire(from) : require;
        req(specifier);
        return 'OK      ' + specifier;
    } catch (error) {
        const code = error && error.code ? error.code + ': ' : '';
        const first = String((error && error.message) || error).split('\n')[0];
        return 'FAIL    ' + specifier + '\n           ' + code + first;
    }
}

/**
 * 跑一次自检并把结果写进日志。
 * @param {(msg: string) => void} log - launcher 的日志函数（写 dsh.log）。
 * @param {string} dataDir - 应用 filesDir。
 * @param {string} runtimeDir - 解压后的运行时根。
 * @param {string} homeDir - DSH_HOME。
 */
function runNativeSelfCheck(log, dataDir, runtimeDir, homeDir) {
    // 先报「这一包到底是哪一份」—— 排查时第一个要确认的事实。
    // tar 的 sha256 前 16 位：只要内容变过就一定不同，可用于确认设备跑的是不是最新包。
    try {
        const tar = path.join(dataDir, 'bundle/dsh-runtime.bin');
        if (fs.existsSync(tar)) {
            const digest = require('node:crypto').createHash('sha256')
                .update(fs.readFileSync(tar)).digest('hex').slice(0, 16);
            log('native self-check: pack digest=' + digest + ' bytes=' + fs.statSync(tar).size);
        } else {
            log('native self-check: pack MISSING at ' + tar);
        }
    } catch (error) {
        log('native self-check: pack digest failed: ' + (error && error.message));
    }
    log('native self-check: platform=' + process.platform + '-' + process.arch
        + ' node=' + process.version + ' execPath=' + process.execPath);
    log('native self-check: argv0=' + process.argv0 + ' TMPDIR=' + (process.env.TMPDIR || '(unset)'));

    const maps = libnodeMaps();
    log('native self-check: libnode mappings = ' + (maps.length ? maps.join(' | ') : '(NONE — libnode 未加载?)'));

    // 校验「硬链接 → 独占创建」补丁是否真的在**当前解压出来的运行时**里。
    //
    // 为什么要专门查这个：link() 被 SELinux neverallow 禁止，补丁必须存在于设备上
    // 实际加载的那份文件里。构建产物、tar、APK 全对但设备上是旧解压产物时，
    // 表现就是「修了却还报同一个 EACCES」。这一步把「补丁在不在运行时里」
    // 变成日志里一行确定的事实，不用再推断。
    const persistenceLib = path.join(
        runtimeDir,
        'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib',
    );
    for (const rel of ['index.js', 'worker.cjs']) {
        const file = path.join(persistenceLib, rel);
        if (!fs.existsSync(file)) {
            log('native self-check: hardlink patch ' + rel + ' -> MISSING FILE');
            continue;
        }
        const patched = fs.readFileSync(file, 'utf8').includes('publishWithExclusiveCreate');
        log('native self-check: hardlink patch ' + rel + ' -> ' + (patched ? 'present' : 'ABSENT (stale runtime!)'));
    }
    for (const [label, rel] of [
        ['attachment-local', 'dsh-attachment-local/lib/index.js'],
        // fs-local 是最晚发现的点：它用别名 linkFile 调用，grep "link(" 看不见。
        ['fs-local', 'dsh-fs-local/lib/index.js'],
    ]) {
        const file = path.join(runtimeDir, 'node_modules/@deepseek-ai', rel);
        if (!fs.existsSync(file)) {
            log('native self-check: hardlink patch ' + label + ' -> MISSING FILE');
            continue;
        }
        const patched = fs.readFileSync(file, 'utf8').includes('linkOrExclusiveCopy');
        log('native self-check: hardlink patch ' + label + ' -> ' + (patched ? 'present' : 'ABSENT (stale runtime!)'));
    }

    // 子进程能力：不再有原生 addon（subprocess 已改回 dsh-subprocess-local），
    // 所以这里只确认 node:child_process 可用 —— 那是唯一的依赖。

    // 决定性实验：node:child_process 能不能起系统二进制？
    // 如果能，就**不需要**任何原生 subprocess addon（也就没有 napi 符号问题）。
    // 早先「Android 不能用 child_process.spawn」的前提可能把两件事混了：
    // 被禁的是 app 私有目录内的 exec，而 /system/bin/sh 在系统分区。
    try {
        const cp = require('node:child_process');
        const r = cp.spawnSync('/system/bin/sh', ['-c', 'echo CHILD_OK; id -u'], { encoding: 'utf8', timeout: 5000 });
        log('native self-check: child_process /system/bin/sh -> status=' + r.status
            + ' stdout=' + JSON.stringify(String(r.stdout || '').trim().slice(0, 60))
            + (r.error ? ' error=' + (r.error.code || r.error.message) : ''));
    } catch (error) {
        log('native self-check: child_process probe threw: ' + (error && error.message));
    }

    // /tmp 在 Android 上不存在；TMPDIR 已由 launcher 指向应用目录。
    // 这里记一行是为了区分「代码走了 os.tmpdir()」还是「硬编码了 /tmp」。
    log('native self-check: /tmp exists = ' + fs.existsSync('/tmp')
        + ' ; TMPDIR writable = ' + (() => {
            try { fs.accessSync(process.env.TMPDIR || '/', fs.constants.W_OK); return true; } catch { return false; }
        })());
    log('native self-check: done');
}

module.exports = { runNativeSelfCheck, libnodeMaps, tryLoad };
