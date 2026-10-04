#!/usr/bin/env node
/**
 * 把 @dsh-desktop/link 装进 DSH Desktop。
 *
 * 桌面插件的加载路径由外壳决定（见 desktop-patch.yml 的说明）：
 *   1. 外壳启动时把 resources/dsh-plugins/<名字> 落位到
 *      $DSH_HOME/profiles/node_modules/@dsh-desktop/<名字>；
 *   2. 再由 desktop-patch.yml 的 insert 把它挂进组合。
 * 所以安装要动**两处**：
 *   · resources/dsh-plugins/link/            （让外壳下次启动能落位）
 *   · $DSH_HOME/profiles/node_modules/@dsh-desktop/link/ （让这次就能用）
 * 只做后者会在外壳下次启动时被覆盖/丢失，只做前者则要等重启。
 *
 * ⚠️ 会改用户的 DSH Desktop 安装目录。改前把 desktop-patch.yml 备份成
 *    desktop-patch.yml.linkbak，并且**可重复执行**（已装过就只更新文件、不重复插入）。
 *
 * 跑法：node scripts/install-desktop-link.mjs [DSH Desktop 根目录]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 文件内容的同步统一由 sync-desktop-plugin.mjs 负责（规范源 → 仓库 + 已安装目录），
// 这里只做「装进正在运行的那份 DSH Desktop」这件事：落 resources/dsh-plugins
// 并改 desktop-patch.yml。职责分开，免得两处各写一份文件清单、迟早不一致。
spawnSync(process.execPath, [path.join(import.meta.dirname, 'sync-desktop-plugin.mjs')], { stdio: 'inherit' });

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'desktop-plugins/@dsh-desktop/link');
// ⚠️ 不写死作者机器上的安装位置：优先命令行参数，其次环境变量，
//    最后取「仓库同级目录下的 DSH Desktop」（多数开发者的布局）。
const DESKTOP = process.argv[2]
    ?? process.env.DSH_DESKTOP_ROOT
    ?? path.resolve(ROOT, '..', 'DSH Desktop');
const RESOURCES_PLUGINS = path.join(DESKTOP, 'resources/dsh-plugins');
const PATCH = path.join(DESKTOP, 'resources/desktop-patch.yml');
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), 'AppData/Roaming/DSH-Desktop/dsh-home');
const INSTALLED = path.join(HOME, 'profiles/node_modules/@dsh-desktop/link');

if (!fs.existsSync(DESKTOP)) {
    console.error('找不到 DSH Desktop：' + DESKTOP);
    console.error('用法：node scripts/install-desktop-link.mjs "C:\\path\\to\\DSH Desktop"');
    process.exit(1);
}

/** 递归复制目录（覆盖）。 */
function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dst);
        else fs.copyFileSync(src, dst);
    }
}

// 1) 放进外壳的插件目录（下次启动由外壳落位）
copyDir(SOURCE, path.join(RESOURCES_PLUGINS, 'link'));
console.log('[install] 已放入 ' + path.join(RESOURCES_PLUGINS, 'link'));

// 2) 直接落位到 profile，让这次就能用
copyDir(SOURCE, INSTALLED);
console.log('[install] 已落位到 ' + INSTALLED);

// 3) 挂进组合
const MARKER = "name: '@dsh-desktop/link'";
if (!fs.existsSync(PATCH)) {
    console.error('[install] 找不到 desktop-patch.yml：' + PATCH);
    process.exit(1);
}
const text = fs.readFileSync(PATCH, 'utf8');
if (text.includes(MARKER)) {
    console.log('[install] desktop-patch.yml 已经挂过，跳过（文件已更新）');
} else {
    fs.copyFileSync(PATCH, PATCH + '.linkbak');
    const block = [
        '',
        '# ── 5) 远程联动（手机 ↔ 桌面）─────────────────────────────────────────────',
        '#',
        '# 给模型一组工具，让桌面与手机互为「远程设备」：',
        '#   link_host_start / link_host_status / link_host_code / link_host_stop',
        '#       桌面侧开服务、生成 6 位配对码；',
        '#   phone_*   操作已配对的手机（状态/截图/元素/点击/滚动/输入/按键/推文件）；',
        '#   link_share_model  把桌面模型配置（含 API Key，走会话密钥加密）发给手机。',
        '#',
        '# 手机侧对应插件是 @dsh-android/link（随 APK 发布），用 link_connect 配对。',
        '# 链路是局域网明文 TCP + 配对令牌；凭据字段用 ECDH 派生的会话密钥 AES-GCM 封装。',
        "# 包本体由桌面外壳落位（resources/dsh-plugins/link → profiles/node_modules/@dsh-desktop/link）。",
        '- insert:',
        '    - id: dsh-desktop-link',
        "      name: '@dsh-desktop/link'",
        '',
    ].join('\n');
    fs.appendFileSync(PATCH, block, 'utf8');
    console.log('[install] 已在 desktop-patch.yml 追加挂载条目（原文件备份为 .linkbak）');
}

// 4) 自检：确认 dsh-tools 与兄弟插件在 profile 里都解析得到
const toolsOk = fs.existsSync(path.join(HOME, 'profiles/node_modules/@deepseek-ai/dsh-tools'));
const cuOk = fs.existsSync(path.join(HOME, 'profiles/node_modules/@dsh-desktop/computer-use/lib/win32.js'));
console.log('[install] dsh-tools 可解析: ' + toolsOk + '；computer-use 可解析: ' + cuOk);
if (!cuOk) {
    console.log('[install] 提示：没有 computer-use 时联动仍可用，只是桌面的 computer.* 会明确报错（刻意的降级）。');
}
console.log('[install] 完成。重启 DSH Desktop 后生效。');
