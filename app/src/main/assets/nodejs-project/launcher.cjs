'use strict';
/**
 * dsh-android Node 入口（nodejs-mobile 加载的第一个脚本）。
 *
 *   argv[2] = 应用数据目录（filesDir）
 *
 * 职责（对应桌面外壳 boot.ts 的链路）：
 *   1) 运行时缺失 → 从 bundle/dsh-runtime.tar.gz 解压（纯 JS，见 extract-tar.cjs）
 *   2) 设定 DSH_HOME / HOME / NO_COLOR 等环境（与桌面版一致）
 *   3) 劫持 stdout：全量写 dsh.log；解析 "dsh web: http://127.0.0.1:<port>/?token=..."
 *      （桌面版铁律：必须解析输出拿地址，不硬编码端口）
 *   4) process.chdir(runtimeDir) 后动态 import dsh 的 bin.js
 *   5) 任何失败 → 写 node-state.json phase=failed
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { Worker } = require('node:worker_threads');
const { extractTarGz } = require('./extract-tar.cjs');

const dataDir = process.argv[2];
if (!dataDir) {
    console.error('launcher: missing dataDir argument');
    process.exit(2);
}

const bundleDir = path.join(dataDir, 'bundle');
const runtimeDir = path.join(dataDir, 'dsh-runtime');
const homeDir = path.join(dataDir, 'dsh-home');
const stateFile = path.join(dataDir, 'node-state.json');
const logFile = path.join(dataDir, 'dsh.log');

const DSH_PACKAGE = '@deepseek-ai/dsh';
/** dsh 启动后打印的一行：dsh web: http://127.0.0.1:<port>/?token=<token> */
const URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/[^\s]*\?token=[A-Za-z0-9._\-]+/;

function writeState(patch) {
    try {
        let prev = {};
        try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }
        fs.writeFileSync(stateFile, JSON.stringify({ ...prev, ...patch }));
    } catch { /* ignore */ }
}

function log(line) {
    try {
        fs.appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n');
    } catch { /* ignore */ }
}

/** 劫持 stdout 抓就绪 URL + 全量落日志（stdout 本身在 Android 指向 /dev/null）。 */
let readyAnnounced = false;
const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, ...rest) {
    try {
        const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        const m = s.match(URL_RE);
        if (m && !readyAnnounced) {
            readyAnnounced = true;
            log('READY ' + m[0]);
            writeState({ phase: 'ready', url: m[0], message: '已就绪' });
        }
        log('[out] ' + s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ''));
    } catch { /* ignore */ }
    return origStdoutWrite(chunk, ...rest);
};

process.on('uncaughtException', (e) => {
    log('uncaughtException ' + (e && e.stack ? e.stack : e));
    writeState({ phase: 'failed', error: String((e && e.message) || e) });
});
process.on('unhandledRejection', (e) => {
    log('unhandledRejection ' + (e && e.stack ? e.stack : e));
    writeState({ phase: 'failed', error: String((e && e.message) || e) });
});
process.on('exit', (code) => {
    log('exit code=' + code);
    if (!readyAnnounced && code !== 0) {
        writeState({ phase: 'failed', error: 'dsh 提前退出（code=' + code + '），详见 dsh.log' });
    }
});

function resolveDshEntry() {
    const pkgFile = path.join(runtimeDir, 'node_modules', DSH_PACKAGE, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    let rel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && (pkg.bin.dsh || Object.values(pkg.bin)[0]));
    if (!rel) throw new Error(DSH_PACKAGE + ' 的 package.json 缺少 bin 字段');
    const entry = path.join(runtimeDir, 'node_modules', DSH_PACKAGE, rel);
    if (!fs.existsSync(entry)) throw new Error('dsh 入口不存在：' + entry);
    return entry;
}

/**
 * 目录内容指纹：按「相对路径 + 大小」排序后哈希。
 * 插件改动时往往忘了改版本号，只看 version 会判定“没变”而跳过复制 ——
 * 表现为“改了插件但没生效”。指纹与版本号解耦，内容一变就重装。
 */
function fingerprintOf(dir) {
    const parts = [];
    const walk = (d, rel) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { walk(p, r); continue; }
            try { parts.push(r + ':' + fs.statSync(p).size); } catch { /* ignore */ }
        }
    };
    walk(dir, '');
    parts.sort();
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * 把外壳自带的插件包拷到 dsh 能解析到的 profile node_modules。
 *
 * @param {string} bundleDir - assets 里 bundle 的落位目录（含 plugins/）。
 * @param {string} modulesDir - $DSH_HOME/profiles/node_modules。
 * @returns {string[]} 本次确认就位的插件包名。
 */
function installShellPlugins(bundleDir, modulesDir) {
    const source = path.join(bundleDir, 'plugins');
    if (!fs.existsSync(source)) {
        log('no bundled shell plugins at ' + source);
        return [];
    }
    fs.mkdirSync(modulesDir, { recursive: true });
    const installed = [];
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        // 插件目录以 scope 组织：@dsh-android/<name>（与桌面 @dsh-desktop/<name> 一致）
        const scopeDir = path.join(source, entry.name);
        if (!entry.isDirectory()) continue;
        for (const e2 of fs.readdirSync(scopeDir, { withFileTypes: true })) {
            if (!e2.isDirectory()) continue;
            const name = entry.name + '/' + e2.name;
            const src = path.join(scopeDir, e2.name);
            const dest = path.join(modulesDir, entry.name, e2.name);
            const marker = path.join(dest, '.dsh-android-managed.json');
            const fingerprint = fingerprintOf(src);
            let previous = null;
            try { previous = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* ignore */ }
            if (previous && previous.fingerprint === fingerprint && fs.existsSync(path.join(dest, 'package.json'))) {
                installed.push(name);
                continue;
            }
            fs.rmSync(dest, { recursive: true, force: true });
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            copyDir(src, dest);
            fs.writeFileSync(marker, JSON.stringify({ fingerprint, managedBy: 'dsh-android' }));
            installed.push(name);
            log('installed shell plugin ' + name + ' (' + fingerprint + ')');
        }
    }
    // 清理「上一版有、这一版没了」的插件。
    // ⚠️ 只写不删会让被移除的插件永远留在 profile 里 —— 实测 v0.3.0 已经不再随包
    //    发布 subprocess-rs，但设备上它还在，连它那个必然加载失败的原生 addon
    //    也一起留着。判断依据是本外壳写的 .dsh-android-managed.json 标记，
    //    绝不碰用户自己装的包。
    for (const scope of fs.existsSync(modulesDir) ? fs.readdirSync(modulesDir, { withFileTypes: true }) : []) {
        if (!scope.isDirectory()) continue;
        const scopeDir = path.join(modulesDir, scope.name);
        for (const pkg of fs.readdirSync(scopeDir, { withFileTypes: true })) {
            if (!pkg.isDirectory()) continue;
            const name = scope.name + '/' + pkg.name;
            if (installed.includes(name)) continue;
            const dir = path.join(scopeDir, pkg.name);
            if (!fs.existsSync(path.join(dir, '.dsh-android-managed.json'))) continue;
            fs.rmSync(dir, { recursive: true, force: true });
            log('removed stale shell plugin ' + name);
        }
    }
    if (installed.length > 0) log('shell plugins ready: ' + installed.join(', '));
    return installed;
}

/** 递归复制目录（目标已由调用方清空）。 */
function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dst);
        else if (entry.isFile()) fs.copyFileSync(src, dst);
    }
}

/**
 * 解析用户选择的工作区，作为 dsh 的 cwd —— 补丁里的 workspaceRoot 取的是
 * `process.cwd()`，所以 chdir 到哪里，工作区就是哪里。
 *
 * 用户在 UI 里选好路径后由 NodeService 写 filesDir/.workspace；这里只做校验，
 * 任何一项不满足就退回私有目录并记一行日志 —— 引擎不能因为一个坏路径起不来。
 *
 * @returns {string} 存在且可写的目录绝对路径。
 */
function resolveWorkspace() {
    const fallback = path.join(dataDir, 'workspace');
    let chosen = '';
    try {
        chosen = fs.readFileSync(path.join(dataDir, '.workspace'), 'utf8').trim();
    } catch {
        // 用户没选过：用默认私有目录
    }
    const candidate = chosen || fallback;
    try {
        if (!fs.statSync(candidate).isDirectory()) throw new Error('not a directory');
        fs.accessSync(candidate, fs.constants.W_OK);
        if (candidate !== fallback) log('workspace ' + candidate);
        return candidate;
    } catch (error) {
        log('workspace ' + candidate + ' unusable (' + error.message + '), falling back to ' + fallback);
        fs.mkdirSync(fallback, { recursive: true });
        return fallback;
    }
}

async function main() {
    log('launcher start pid=' + process.pid + ' dataDir=' + dataDir);
    writeState({ phase: 'starting', message: '正在启动…' });

    // 1) 运行时就绪性。⚠️ pack 指纹检查必须在 pkgFile 检查之外：
    //    否则旧解压产物（缺新文件）会让分支整体跳过、新包内容永远到不了
    const pkgFile = path.join(runtimeDir, 'node_modules', DSH_PACKAGE, 'package.json');
    {
        // 历史版本曾把运行时平铺解压到 dataDir 根，检测到残留就清掉
        const legacyFlat = path.join(dataDir, 'node_modules');
        if (fs.existsSync(legacyFlat)) {
            writeState({ phase: 'starting', message: '清理旧版解压残留…' });
            log('removing legacy flat runtime at ' + legacyFlat);
            fs.rmSync(legacyFlat, { recursive: true, force: true });
            for (const junk of ['package.json', 'package-lock.json', '_probe-plugin.mjs', 'node-stderr.log']) {
                try { fs.rmSync(path.join(dataDir, junk), { force: true }); } catch { /* ignore */ }
            }
        }
        const candidates = ['dsh-runtime.bin', 'dsh-runtime.tar.gz', 'dsh-runtime.tar'];
        let tar = null;
        for (const name of candidates) {
            const p = path.join(bundleDir, name);
            if (fs.existsSync(p)) { tar = p; break; }
        }
        if (!tar) throw new Error('运行时与内置包同时缺失，请重新安装应用');
        const packMarker = path.join(dataDir, '.runtime-pack.json');
        const binSize = fs.statSync(tar).size;
        // ⚠️ 指纹必须用**内容哈希**，不能用大小。
        // 早先只比 binSize，于是「改了内容但 gzip 后字节数恰好相同」时会被判定为
        // 未变 → 跳过重解压 → 设备一直跑旧文件，表现为「明明修好了却没生效」。
        // 这个坑排查成本极高（构建产物、APK、tar 全对，只有设备上那份是旧的）。
        // 44MB 的 sha256 在设备上约 0.2s，相对解压（数秒到数十秒）可忽略。
        const binDigest = crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex').slice(0, 16);
        let marker = {};
        try { marker = JSON.parse(fs.readFileSync(packMarker, 'utf8')); } catch { /* ignore */ }
        const packChanged = marker.digest !== binDigest;
        const needExtract = !fs.existsSync(pkgFile) || packChanged;
        if (packChanged && fs.existsSync(runtimeDir)) {
            writeState({ phase: 'starting', message: '清理旧版运行时…' });
            log('runtime pack changed (' + (marker.digest || marker.binSize || '?') + ' -> ' + binDigest
                + ', ' + binSize + ' bytes), re-extracting');
            fs.rmSync(runtimeDir, { recursive: true, force: true });
        }
        if (needExtract) {
            writeState({ phase: 'starting', message: '解压运行时（仅首次启动，需要几分钟）…' });
            const t0 = Date.now();
            // ⚠️ 解压目标是 runtimeDir（tar 根即运行时内容），不是 dataDir
            fs.mkdirSync(runtimeDir, { recursive: true });
            const st = await extractTarGz(tar, runtimeDir);
            fs.writeFileSync(packMarker, JSON.stringify({ binSize, digest: binDigest, files: st.files }));
            log('extracted from ' + path.basename(tar) + ': files=' + st.files + ' dirs=' + st.dirs +
                ' bytes=' + st.bytes + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
            if (!fs.existsSync(pkgFile)) throw new Error('运行时解压后仍缺 ' + DSH_PACKAGE + '，包可能损坏');
        }
    }

    // 2) 环境（与桌面版一致：DSH_HOME + NO_COLOR）
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
    process.env.DSH_HOME = homeDir;
    process.env.HOME = dataDir;
    process.env.NO_COLOR = '1';
    process.env.TMPDIR = path.join(dataDir, 'tmp');
    process.env.PATH = '/system/bin:/system/xbin' + (process.env.PATH ? ':' + process.env.PATH : '');
    // 应用私有目录：mobile_use 插件靠它找无障碍服务的文件桥。
    // 不能靠 cwd —— cwd 现在是用户选的工作区，可能远在 /sdcard 上。
    process.env.DSH_ANDROID_FILES_DIR = dataDir;
    delete process.env.NODE_OPTIONS;

    // 2b) 外壳插件落位：把 @dsh-android/subprocess-rs 等插件放进
    //     $DSH_HOME/profiles/web/node_modules/<scope>/<name>/。
    //
    // 带指纹戳（与桌面一致）：源没变就跳过复制，启动更快。
    //
    // ⚠️ 落位是 **profile 目录**的 node_modules（$DSH_HOME/profiles/web/），
    //    与桌面外壳一致。早先这里写的是 <runtimeDir>/node_modules，理由是
    //    “Android 上 profile 解析拦截装不起来，Loader 会退化成裸 import(name)”，
    //    —— 那个前提是错的：拦截层装得起来（见步骤 2b 的 --expose-internals 与
    //    require-builtin stub），而无论拦截与否，Loader 的 ctx.baseUrl 都被设成
    //    profile 根目录，裸包名就以它为基准解析：
    //      Cannot find package '@dsh-android/subprocess-rs'
    //      imported from .../profiles/web/
    //    实测装到 <runtimeDir>/node_modules 时该行必然 failed to import；
    //    装到 profile 下才挂得上（未激活条目 10 → 3）。
    installShellPlugins(bundleDir, path.join(homeDir, 'profiles', 'web', 'node_modules'));

    // 2c) 原生插件加载自检。
    //     会话持久化要 flock → flock 要加载 system.node → 加载失败则会话起不来 →
    //     工具调不到。也就是说「能跑诊断工具」和「需要诊断」互斥。所以把自检放在
    //     launcher：它在 dsh 之前、同一进程里跑，用的是完全相同的 dlopen 机制，
    //     结论对 dsh 同样成立，而且结果直接落进 dsh.log。
    //     全程 try/catch —— 自检绝不能拖垮启动。
    try {
        require('./native-selfcheck.cjs').runNativeSelfCheck(log, dataDir, runtimeDir, homeDir);
    } catch (error) {
        log('native self-check failed to run: ' + (error && error.message));
    }

    // 3) 启动 dsh web：--port 0 让 OS 分配，地址从 stdout 解析
    const entry = resolveDshEntry();
    const patch = path.join(bundleDir, 'android-patch.yml');
    process.chdir(resolveWorkspace());
    // ⚠️ 用户设置补丁必须排在 android-patch.yml **之后** —— --patch 是顺序应用、
    //    后者覆盖前者，而 home 层（$DSH_HOME/cordis.patch.yml）实测是被 --patch
    //    压过的（见 DshSettings.kt 的说明）。所以外壳设置走这个位置。
    const userPatch = path.join(dataDir, 'dsh-user-patch.yml');
    const dshArgv = ['--profile', 'web', '--patch', patch];
    if (fs.existsSync(userPatch)) dshArgv.push('--patch', userPatch);
    dshArgv.push('--no-open', '--port', '0');
    log('spawn worker ' + entry + ' argv=' + JSON.stringify(dshArgv));

    // ⚠️ 不能直接 import(bin.js)：bin.js 第 168 行 `if (import.meta.main) await runCli()`
    // 在动态 import 下为 false → 静默跳过。Worker 的入口模块 import.meta.main === true，
    // 且 argv 语义与 CLI 一致（process.argv = [execPath, entry, ...workerArgv]），
    // 同时避开 Android 禁止 exec 的限制（桌面版是 spawn 子进程，Android 上不可行）。
    // stdout/stderr 显式接管成 pipe（默认行为不可靠，实测输出丢失）。
    //
    // ⚠️ execArgv 里的 --expose-internals 是**必需**的，不是优化：
    // dsh 的 profile 解析层（dsh-app-boot 的 installRuntimeInterception →
    // internalModules()）要 require('internal/modules/esm/loader') 这类 Node
    // 内部模块来接管模块解析。正常 Node 走 requireBuiltin(内部 id) 桥接，
    // 而那个桥（node-addon-require-builtin）只有 darwin/linux/win32 三个
    // optionalDependency，**没有 android-arm64** → require() 直接抛
    // MODULE_NOT_FOUND，host preparation 阶段就 fatal。
    // 带上该 flag 后走 require(id) 分支，Worker 线程同样继承（已实测）。
    const worker = new Worker(entry, {
        argv: dshArgv,
        stdout: true,
        stderr: true,
        execArgv: ['--expose-internals'],
    });

    function pipeStream(stream, tag) {
        stream.on('data', (chunk) => {
            const s = chunk.toString('utf8').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
            for (const line of s.split('\n')) {
                if (line.trim()) log(tag + ' ' + line.trim());
            }
            if (tag === '[dsh]') {
                const m = s.match(URL_RE);
                if (m && !readyAnnounced) {
                    readyAnnounced = true;
                    log('READY ' + m[0]);
                    writeState({ phase: 'ready', url: m[0], message: '已就绪', error: '' });
                }
            }
        });
    }
    pipeStream(worker.stdout, '[dsh]');
    pipeStream(worker.stderr, '[dsh-err]');

    worker.on('exit', (code) => {
        log('worker exit code=' + code);
        if (!readyAnnounced) {
            writeState({ phase: 'failed', error: 'dsh 提前退出（code=' + code + '），详见 dsh.log' });
        }
    });
    worker.on('error', (e) => {
        log('worker error ' + (e && e.stack ? e.stack : e));
        if (!readyAnnounced) writeState({ phase: 'failed', error: String((e && e.message) || e) });
    });
}

main().catch((e) => {
    log('FATAL ' + (e && e.stack ? e.stack : e));
    writeState({ phase: 'failed', error: String((e && e.message) || e) });
    process.exitCode = 1; // 非 0 退出，让外壳知道引擎没有正常返回
});
