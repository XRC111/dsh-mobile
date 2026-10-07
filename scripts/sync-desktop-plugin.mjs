#!/usr/bin/env node
/**
 * 把桌面侧联动插件同步到 dsh-desktop 仓库与已安装的 DSH Desktop。
 *
 * ── 为什么需要这个脚本 ──────────────────────────────────────────────────────
 * 这个插件同时存在于两个仓库：
 *   · dsh-android/desktop-plugins/@dsh-desktop/link  —— **规范源**。线路协议、
 *     双端集成测试都在这里，改代码改这边；
 *   · dsh-desktop/resources/dsh-plugins/link          —— 分发副本。外壳会把它
 *     落位到 profiles/node_modules/@dsh-desktop/link。
 * 手工同步过几次，迟早会出现「一边改了另一边没改」—— 而这种不一致的表现是
 * 「功能时好时坏」，最难查。所以同步写成脚本，并由
 * scripts/link-protocol-copies.test.mjs 逐字节校验。
 *
 * 跑法：node scripts/sync-desktop-plugin.mjs
 * 环境变量 DSH_DESKTOP_REPO 可覆盖 dsh-desktop 仓库位置（默认为本仓库的同级目录）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'desktop-plugins/@dsh-desktop/link');
// ⚠️ 不要写死作者机器上的路径。默认取「仓库的同级目录」——大多数人是把
//    dsh-android 和 dsh-desktop clone 在一起。找不到就跳过（脚本本来就会跳过），
//    所以没配这个仓库的人不会因此构建失败。
const REPO = process.env.DSH_DESKTOP_REPO ?? path.resolve(ROOT, '..', 'dsh-desktop');
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), 'AppData/Roaming/DSH-Desktop/dsh-home');

/** 需要同步的文件（显式列出，避免把临时文件也带过去）。 */
const FILES = [
    'package.json',
    // ⚠️ 客户端半个插件也要同步：它是设置页那一半，漏了界面上就看不到这一节。
    'client/client.js',
    'lib/index.js',
    'lib/link-protocol/protocol.js',
    'lib/link-protocol/connection.js',
    'lib/link-protocol/endpoint.js',
    'lib/link-protocol/secret.js',
    // ⚠️ 协议文件是**逐个列出**的，新增一个（这里漏了 routes.js）分发副本就会缺它，
    //    而 link-protocol-copies.test.mjs 会立刻报「分发副本缺 ...」。这个断言就是为了
    //    让「加文件忘了同步」在本地就暴露，而不是等到用户点开设置页发现白屏。
    'lib/link-protocol/routes.js',
    'lib/link-protocol/netinfo.js',
    'lib/link-protocol/llmrelay.js',
    'lib/link-protocol/relayexec.js',
    // mesh 三件套：桌面侧也要用它做多设备去重与寻址。
    'lib/link-protocol/mesh-identity.js',
    'lib/link-protocol/mesh-registry.js',
    'lib/link-protocol/mesh-manager.js',
];

/**
 * 把规范源的文件复制到目标目录。
 * @param {string} dest - 目标插件根目录。
 * @returns {number} 复制的文件数。
 */
function syncTo(dest) {
    let count = 0;
    for (const rel of FILES) {
        const from = path.join(SOURCE, rel);
        const to = path.join(dest, rel);
        if (!fs.existsSync(from)) throw new Error('规范源缺文件：' + rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        count += 1;
    }
    return count;
}

// 1) dsh-desktop 仓库（分发源）
if (fs.existsSync(REPO)) {
    const dest = path.join(REPO, 'resources/dsh-plugins/link');
    const n = syncTo(dest);
    console.log('[link] 已同步 ' + n + ' 个文件到仓库 ' + path.relative(REPO, dest));
} else {
    console.log('[link] 跳过仓库同步（找不到 ' + REPO + '，可用 DSH_DESKTOP_REPO 指定）');
}

// 2) 已安装的 DSH Desktop。
//
// ⚠️⚠️ **默认不写**，要写必须显式加 --installed。
//
// 这不是洁癖：这个脚本在多处被自动调用（sync-link-protocol 之后、CI、
// 我自己的例行流程），而它会**直接覆盖正在运行的 DSH Desktop 的插件**。
// 后果不是「改错代码」，而是「用户的应用被动了而他不知道」——
// 而且已安装的那份由应用自己的热更机制管理（带 dshDesktopBuild 戳、
// 版本号由内容哈希自动升），手动覆盖可能与它不一致。
//
// 真正需要「改了立刻在应用里生效」时（开发调试），才用 --installed。
const wantInstalled = process.argv.includes('--installed');
const installed = path.join(HOME, 'profiles/node_modules/@dsh-desktop/link');
if (!wantInstalled) {
    console.log('[link] 跳过已安装目录（要写请加 --installed）');
} else if (fs.existsSync(path.join(HOME, 'profiles/node_modules/@dsh-desktop'))) {
    const n = syncTo(installed);
    console.log('[link] 已同步 ' + n + ' 个文件到已安装目录');
} else {
    console.log('[link] 跳过已安装目录同步（没有 DSH Desktop profile）');
}
