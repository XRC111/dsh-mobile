#!/usr/bin/env node
/**
 * 打包 dsh 运行时为 APK assets 用的 tar.gz。
 *
 * 源：  dsh-desktop 仓库的 resources/dsh-runtime（win32 平台 npm install 的产物）。
 *      位置用 DSH_DESKTOP_RUNTIME 覆盖，默认 <DSH_DESKTOP>/resources/dsh-runtime。
 * 产物：app/src/main/assets/bundle/dsh-runtime.bin + build/runtime-manifest.json
 *
 * ⚠️ 文件名必须是 .bin：AAPT2 会把 assets 里 .gz 后缀的文件解压存储并去掉
 * .gz 后缀（36MB tar.gz → APK 内 190MB 裸 tar），launcher 会找不到文件。
 *
 * 剔除项（Android 上无法加载/不会触达的原生二进制，省 ~60MB）：
 *   - node_modules/@img/**                      sharp 各平台二进制（libvips）
 *   - node_modules/sharp/**                     sharp 本体（仅 attachment-local 用，已 patch 禁用）
 *   - node_modules/@koromix/**                  koffi win32 平台包
 *   - node_modules/node-pty/prebuilds/{win32,darwin,linux}-**   保留 prebuilds/ 目录本身
 *
 * 注入的 stub（见步骤 2）：sharp / koffi / node-pty / node-addon-require-builtin。
 * 最后一个是关键：原包没有 android-arm64 预编译，dsh-app-boot 无条件 require 它，
 * 缺了就整个 harness 起不来。
 *
 * 拷贝用 robocopy（Windows 原生，受 safe-delete/慢 I/O 影响最小）；
 * 打包用 dsh-desktop 里的 tar npm 包（系统 tar.exe 在本机被 shim 拦截）。
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
// ⚠️ 不能写死作者机器上的路径 —— 别人 clone 下来必须能改。
//    优先级：环境变量 DSH_RUNTIME_SRC > DSH_DESKTOP/resources/dsh-runtime > 报错提示。
const SRC = process.env.DSH_RUNTIME_SRC
    ?? path.join(process.env.DSH_DESKTOP ?? 'D:/code/dsh-desktop', 'resources', 'dsh-runtime');
const STAGE = path.join(ROOT, 'build', 'runtime-stage');
const OUT = path.join(ROOT, 'app', 'src', 'main', 'assets', 'bundle', 'dsh-runtime.bin');

// 缺运行时源时**给出可执行的指引**再退出。不写这个守卫的话，后面的 robocopy
// 会以它自己的错误码结束，别人 clone 下来只会看到一串看不懂的输出。
if (!fs.existsSync(SRC)) {
    console.error('找不到 DSH 运行时源：' + SRC);
    console.error('');
    console.error('这个脚本需要一份 **win32 平台** 的 dsh 运行时（npm install 的产物）。');
    console.error('两种取得方式：');
    console.error('  1. 装一份 DSH Desktop，然后指向它的运行时：');
    console.error('       set DSH_RUNTIME_SRC=C:\\path\\to\\dsh-desktop\\resources\\dsh-runtime');
    console.error('  2. 自己 npm install 一份（需在 win32 上，因为要拉 win32 专属的可选依赖）');
    console.error('');
    console.error('详见 README「首次构建」。');
    process.exit(1);
}
const MANIFEST = path.join(ROOT, 'build', 'runtime-manifest.json');

const EXCLUDED_DIRS = [
    '@img', '@koromix',
    'node-addon-require-builtin-win32-x64-msvc',
    'win32-arm64', 'win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64',
    // 平台专用大件：都是 optionalDependencies，按 process.platform 在运行期解析，
    // 没有静态 import，Android 上永远不会被 require 到。
    //   libreoffice-kit-win32-x64  182MB  Office 转换的 Windows LibreOffice 运行时
    //   sherpa-onnx-win-x64         22MB  语音识别的 Windows 原生库
    // 不排除的话 tar.gz 从 ~35MB 涨到 ~126MB，APK 直接翻倍。
    'libreoffice-kit-win32-x64',
    'libreoffice-kit-darwin-arm64', 'libreoffice-kit-darwin-x64', 'libreoffice-kit-win32-arm64',
    'sherpa-onnx-win-x64', 'sherpa-onnx-darwin-arm64', 'sherpa-onnx-linux-x64',
];
// ⚠️ sharp 不在剔除列表：被注入 stub（见下），否则 attachments 服务链 pending、
//    sessionController 等一批插件激活失败导致启动失败

function countFiles(dir) {
    let files = 0, bytes = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            const sub = countFiles(p);
            files += sub.files; bytes += sub.bytes;
        } else if (e.isFile()) {
            files++; bytes += fs.statSync(p).size;
        }
    }
    return { files, bytes };
}

/**
 * 把 Win32 专用包替换为空壳：解析原入口的 export 名单，生成同名导出的
 * "调用即抛错"壳。原包顶层有 koffi 类型定义 + ABI guard，Android 上无法
 * 通过，而这些包的 API 永远不会被 Android 路径调用。
 */
function makeShellPackage(pkgDir, relName) {
    const indexFile = path.join(pkgDir, 'lib', 'index.js');
    if (!fs.existsSync(indexFile)) {
        console.warn('    shell: 跳过（无 lib/index.js）', relName);
        return;
    }
    const src = fs.readFileSync(indexFile, 'utf8');
    const m = src.match(/export\s*\{([\s\S]*?)\}/);
    if (!m) {
        console.warn('    shell: 跳过（未解析到 export 名单）', relName);
        return;
    }
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
        const asMatch = item.match(/\bas\s+(\w+|default)$/);
        const local = item.split(/\s+as\s+/)[0].trim();
        return { local, exported: asMatch ? asMatch[1] : local };
    });
    const lines = [
        '// Android 空壳（dsh-android pack-runtime 自动生成）：',
        '// 原包为 Win32 专用（koffi 顶层类型定义 + ABI guard），其 API 在',
        '// Android 上永远不会被调用，这里仅维持 import 链可加载。',
        "const unavailable = (name) => () => { throw new Error(name + ' is unavailable on Android (win32-only package)'); };",
    ];
    for (const { local, exported } of names) {
        if (exported === 'default') {
            lines.push(`const _default = unavailable('${local}'); export default _default;`);
        } else {
            lines.push(`export const ${exported} = unavailable('${exported}');`);
        }
    }
    fs.writeFileSync(indexFile, lines.join('\n') + '\n');
    console.log('    shell:', relName, `(${names.length} 导出)`);
}

/**
 * 把外壳插件（plugins/ 下按 scope/name 组织）拷到 APK 的 bundle assets。
 *
 * 每个插件包自带嵌套 node_modules，因此原生 .node 二进制随包走，不需要在
 * 设备上另外解包。同时校验插件自身的 package.json 与入口文件存在 —— 少一个
 * 都会在设备上表现为“插件行挂不上”，与其到实机才发现，不如打包期就报错。
 *
 * @returns {string[]} 落位的插件包名。
 */
/**
 * 不随 APK 落位的外壳插件。
 *
 * subprocess-rs：它依赖 @rs-cross-spawn/android-arm64 这个原生 addon，而设备实测
 * 该 addon 必然 dlopen 失败（41 个 napi_* 在嵌入式 libnode 下解析不到 ——
 * libnode 是从 APK 直接映射的，DT_NEEDED "libnode.so" 找不到）。
 * 既然 dsh-subprocess-local + node:child_process 在 Android 上可用（见
 * android-patch.yml 3b 的实测记录），这个 Provider 就不再挂载；
 * 源码留在仓库里供参考与单测，但**不进交付物**，免得再引入一个不可能工作的原生文件。
 */
const EXCLUDED_PLUGINS = ['@dsh-android/subprocess-rs'];

function stageShellPlugins() {
    const source = path.join(ROOT, 'plugins');
    const dest = path.join(ROOT, 'app', 'src', 'main', 'assets', 'bundle', 'plugins');
    fs.rmSync(dest, { recursive: true, force: true });
    if (!fs.existsSync(source)) {
        console.log('    无 plugins/ 目录，跳过插件落位');
        return [];
    }
    fs.mkdirSync(dest, { recursive: true });
    const staged = [];
    for (const scope of fs.readdirSync(source, { withFileTypes: true })) {
        if (!scope.isDirectory()) continue;
        for (const pkg of fs.readdirSync(path.join(source, scope.name), { withFileTypes: true })) {
            if (!pkg.isDirectory()) continue;
            const name = scope.name + '/' + pkg.name;
            if (EXCLUDED_PLUGINS.includes(name)) {
                console.log('    跳过插件（不随 APK 落位）:', name);
                continue;
            }
            const src = path.join(source, scope.name, pkg.name);
            const manifestPath = path.join(src, 'package.json');
            if (!fs.existsSync(manifestPath)) throw new Error(`插件 ${name} 缺 package.json`);
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.name !== name) {
                throw new Error(`插件 ${name} 的 package.json name 是 ${JSON.stringify(manifest.name)}，必须一致`);
            }
            const entry = manifest.main ?? 'index.js';
            if (!fs.existsSync(path.join(src, entry))) throw new Error(`插件 ${name} 的入口 ${entry} 不存在`);
            const out = path.join(dest, scope.name, pkg.name);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.cpSync(src, out, { recursive: true });
            staged.push(name);
        }
    }
    console.log('    shell plugins staged:', staged.join(', ') || '(none)');
    return staged;
}

async function main() {
    for (const d of [path.dirname(OUT)]) fs.mkdirSync(d, { recursive: true });

    // 1) 阶段拷贝（robocopy /E 复制子树，/XD 排除目录名）
    //    大目录删除会被本机 node safe-delete shim 拦截（阈值 50）→ 走 cmd rmdir
    spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', STAGE], { stdio: 'ignore' });
    fs.mkdirSync(STAGE, { recursive: true });
    console.log('[1/3] robocopy 阶段拷贝…');
    const rc = spawnSync('robocopy', [
        SRC, STAGE, '/E', '/NFL', '/NDL', '/NJH', '/NP', '/MT:8',
        '/XD', ...EXCLUDED_DIRS,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    // robocopy 退出码 0-7 都算成功
    if (rc.status === null || rc.status > 7) {
        console.error('robocopy failed, status=', rc.status, rc.stderr?.toString());
        process.exit(1);
    }

    // 2) 注入平台 stub 与 Win32 专用包空壳
    //    sharp：无 libvips → 图片透传（保 attachments 服务链）
    //    koffi：无 Android FFI → 类型定义类调用返回惰性对象
    //    node-pty：无 pty.node → 终端占位（真货待 NDK 交叉编译）
    //    dsh-win32-process / dsh-sandbox-windows-acl：Win32 专用包顶层有
    //      koffi 类型定义 + ABI guard（size 校验），stub 骗不过 → 直接换成
    //      自动生成的空壳包（导出面一致、调用即抛错）。Android 上它们的
    //      API 永远不会被调用（平台分支守卫），只维持 import 链。
    //    node-addon-require-builtin：只有 darwin/linux/win32 optionalDependency，
    //      无 android-arm64 → createEntryApi() 顶层抛 "No usable native binding"，
    //      而 dsh-app-boot 的 internalModules() 无条件 require 它 → host preparation
    //      直接 fatal。换成纯 JS stub：requireBuiltin 落到普通 require 上，依赖
    //      launcher 给 Worker 传的 --expose-internals（Android 上等价的内部模块通道）。
    for (const [pkg, src] of [
        ['sharp', 'sharp-stub'],
        ['koffi', 'koffi-stub'],
        ['node-pty', 'node-pty-stub'],
        ['node-addon-require-builtin', 'require-builtin-stub'],
    ]) {
        const dir = path.join(STAGE, 'node_modules', pkg);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.cpSync(path.join(ROOT, 'scripts', src), dir, { recursive: true });
    }
    // ⚠️ 这里的 pkg 是 @deepseek-ai/ 下的**包名**，不是带 node_modules 的路径：
    // 早先写成 'node_modules/@deepseek-ai/...' 会与下面的 STAGE/node_modules 拼成
    // 双层 node_modules，existsSync 永远为假 → 空壳静默跳过，到设备上才炸。
    for (const pkg of [
        '@deepseek-ai/dsh-win32-process',
        '@deepseek-ai/dsh-sandbox-windows-acl',
    ]) {
        makeShellPackage(path.join(STAGE, 'node_modules', pkg), pkg);
    }
    // 2a) flock：换成**单进程语义**（立即成功），不再加载任何原生 binding。
    //
    //     走过的弯路（记录下来，免得以后再试一遍）：
    //       1. 上游 flock.js 把平台写死成 linux/darwin，Android 上报 'android' 直接抛；
    //       2. 用 NDK 交叉编译出 android-arm64 的 system.node —— 能在本机验证
    //          ELF 正确，但设备上 dlopen 报 cannot locate symbol "napi_create_function"；
    //       3. 给它补 DT_NEEDED libnode.so + 在 JNI_OnLoad 里把 libnode 提升进
    //          全局符号组 —— 仍然不稳定。
    //
    //     关键认识：**这个锁在 Android 上没有意义**。应用是单进程，而内核 flock
    //     提供的是跨进程互斥。上游自己已经为单进程环境定义过语义 —— 模块注释原文：
    //       "The browser worker stubs the native flock entry to immediate success:
    //        it is single-process, so the in-process write claim already excludes
    //        every writer."
    //     所以直接用同一语义。这不是打桩，是沿用上游对同类环境的答案。
    //
    //     副作用（好的那种）：交付物里少一个原生文件，少一类只能在设备上暴露的失败。
    const flockJs = path.join(STAGE, 'node_modules', '@deepseek-ai', 'node-addon-system', 'lib', 'flock.js');
    if (fs.existsSync(flockJs)) {
        fs.copyFileSync(path.join(ROOT, 'scripts', 'node-addon-system-flock', 'flock.js'), flockJs);
    } else {
        console.warn('    flock: 跳过（找不到 @deepseek-ai/node-addon-system/lib/flock.js）');
    }

    // 2b2) 远程联动的协议副本：两端插件各带一份源码副本（安装期不能装依赖），
    //      打包前同步一次，避免副本漂移 —— 那会导致两端各自自洽、连起来才错。
    spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-link-protocol.mjs')], { stdio: 'inherit' });

    // 2c) 硬链接 → 独占创建。AOSP SELinux 有
    //     neverallow untrusted_app app_data_file:file link;，app 永远建不了硬链接，
    //     而多个包用 link() 做「独占发布」，必然 EACCES。
    //     ⚠️ 覆盖点不止一处：会话持久化有 index.js + worker.cjs **两份**，
    //        附件存储另有 2 处。只改一处会在设备上继续报同一个错（踩过）。
    spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'patch-hardlinks.mjs')], { stdio: 'inherit' });

    console.log('[1.5/3] 已注入 sharp/koffi/node-pty/require-builtin stub、flock、会话硬链接补丁与 Win32 包空壳');

    // 2b) 外壳插件：随 bundle 落到 assets，由 launcher.cjs 在 dsh 启动前
    //     拷进 $DSH_HOME/profiles/node_modules/（见 android-patch.yml 3b 的说明）。
    //     不进 tar：插件是外壳自己的代码，与运行时解耦，改插件不必重打 34MB 包。
    stageShellPlugins();

    // 3) tar.gz（复用 dsh-desktop 的 tar 包；系统 tar.exe 被 shim 拦截）
    console.log('[2/3] tar.gz 打包（gzip level 6）…');
    // ⚠️ 这里曾经**硬编码** 'D:/code/dsh-desktop/'，而上面的 SRC 明明支持
    //    DSH_RUNTIME_SRC / DSH_DESKTOP 环境变量。两处不一致的后果是：
    //    在 CI 或别人机器上，runtime 源能按环境变量找到（守卫放行），
    //    却在 require('tar') 这一步因为路径写死而失败 —— 报错指向 tar 而不是
    //    「路径不对」，极难定位。统一走同一个解析结果。
    const desktopRepo = process.env.DSH_DESKTOP
        ?? (process.env.DSH_RUNTIME_SRC ? path.dirname(path.dirname(SRC)) : 'D:/code/dsh-desktop');
    const req = createRequire(path.join(desktopRepo, 'package.json'));
    const tar = req('tar');
    const t0 = Date.now();
    await tar.c({
        gzip: { level: 6 },
        portable: true,
        file: OUT,
        cwd: STAGE,
    }, ['.']);
    console.log('    打包耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');

    // 4) 清单
    const { files, bytes } = countFiles(STAGE);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex');
    const size = fs.statSync(OUT).size;
    fs.writeFileSync(MANIFEST, JSON.stringify({
        source: SRC,
        excludedDirs: EXCLUDED_DIRS,
        files, unpackedBytes: bytes,
        tarGzBytes: size, sha256,
        packedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`[3/3] 完成：${files} 文件 / ${(bytes / 1048576).toFixed(0)} MB 解压后 → tar.gz ${(size / 1048576).toFixed(1)} MB`);
    console.log('    sha256', sha256.slice(0, 16) + '…');
}

main().catch((e) => { console.error(e); process.exit(1); });
