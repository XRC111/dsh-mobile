#!/usr/bin/env node
/**
 * 把共享的线路协议源码同步进两个插件包。
 *
 * ── 为什么是复制，不是依赖 ──────────────────────────────────────────────────
 * 两端插件都不能在安装期跑 npm install：
 *   · 桌面侧由 DSH Desktop 外壳整体落位，多一个依赖就多一个可能落不下来的东西；
 *   · 手机侧在 nodejs-mobile 里跑，根本没有包管理器（Android 上装不了 pnpm，见
 *     android-patch.yml 里关掉 plugin-manager 的记录）。
 * 所以协议以**源码副本**的形式随插件走。
 *
 * ⚠️ 复制而不是「各写一份」：副本必须逐字节相同，否则两端会各自漂移。
 *    scripts/link-protocol.test.mjs 会校验副本与源一致，漂移了测试就红。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'packages/dsh-link-protocol/lib');
const FILES = [
    'protocol.js',
    'connection.js',
    'endpoint.js',
    'secret.js',
    'routes.js',
    'netinfo.js',
    'llmrelay.js',
    'relayexec.js',
    // mesh 三件套：两端都要用它做「我是谁 / 我认识谁 / 现在连上了谁」，
    // 和协议层一样必须逐字节一致（deviceId 算法、拨号仲裁一旦两边不同，
    // 表现是「有时能连有时连出两条」，比直接报错难查得多）。
    'mesh-identity.js',
    'mesh-registry.js',
    'mesh-manager.js',
    // 「经另一台设备调用」的 llm adapter。两端都要 ——
    // 手机与桌面都要让那个 provider 真的出现在模型下拉里。
    'remote-adapter.js',
];

/**
 * 规范源里实际存在的 .js（不含测试）。
 *
 * ⚠️ 与 sync-desktop-plugin 的 FILES 是**同一个坑**：清单是显式的，
 *    新增文件忘了加进来 → 两端副本里都没有 → 运行时
 *    ERR_MODULE_NOT_FOUND，而打包流程一路绿灯（只有用户点开界面才炸）。
 *
 *    已经因为这个丢过一次 remote-adapter.js，所以这里加断言：
 *    同步前扫一遍，多了或少了都直接报错并列出差异。
 */
function auditList() {
    const onDisk = fs.readdirSync(SOURCE)
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .sort();
    const listed = [...FILES].sort();
    const missing = onDisk.filter((f) => !listed.includes(f));
    const stale = listed.filter((f) => !onDisk.includes(f));
    if (missing.length || stale.length) {
        const lines = [];
        if (missing.length) lines.push('规范源里有、清单里没有：\n  ' + missing.join('\n  '));
        if (stale.length) lines.push('清单里有、规范源里没有：\n  ' + stale.join('\n  '));
        throw new Error(
            'sync-link-protocol.mjs 的 FILES 与规范源不一致：\n' + lines.join('\n') +
            '\n漏掉的后果：两端插件里都没有这个文件，运行时报 ERR_MODULE_NOT_FOUND。',
        );
    }
}

auditList();
const TARGETS = [
    path.join(ROOT, 'desktop-plugins/@dsh-desktop/link/lib/link-protocol'),
    path.join(ROOT, 'plugins/@dsh-android/link/lib/link-protocol'),
];

for (const target of TARGETS) {
    fs.mkdirSync(target, { recursive: true });
    for (const file of FILES) {
        fs.copyFileSync(path.join(SOURCE, file), path.join(target, file));
    }
    console.log('[link] 已同步协议副本到 ' + path.relative(ROOT, target));
}
