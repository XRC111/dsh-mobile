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
const FILES = ['protocol.js', 'connection.js', 'endpoint.js', 'secret.js', 'routes.js'];
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
