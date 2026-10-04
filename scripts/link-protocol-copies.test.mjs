/**
 * 线路协议副本防漂移测试。
 *
 * 背景：两端插件各自带一份协议源码副本（scripts/sync-link-protocol.mjs 复制，
 * 因为两端都不能在安装期跑 npm install）。副本一旦和源不一致，就会出现
 * 「桌面按新协议发、手机按旧协议解」这种最难查的问题 —— 两端各自都自洽，
 * 只有连起来才错。
 *
 * 所以这里逐字节比对；不一致就红，并提示跑 sync。
 *
 * 跑法：node scripts/link-protocol-copies.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'packages/dsh-link-protocol/lib');
const FILES = ['protocol.js', 'connection.js', 'endpoint.js', 'secret.js'];
const TARGETS = [
    path.join(ROOT, 'desktop-plugins/@dsh-desktop/link/lib/link-protocol'),
    path.join(ROOT, 'plugins/@dsh-android/link/lib/link-protocol'),
];

for (const target of TARGETS) {
    test('协议副本与源一致：' + path.relative(ROOT, target), () => {
        for (const file of FILES) {
            const src = fs.readFileSync(path.join(SOURCE, file), 'utf8');
            const copyPath = path.join(target, file);
            assert.ok(fs.existsSync(copyPath), '缺副本 ' + file + '（跑 node scripts/sync-link-protocol.mjs）');
            assert.equal(
                fs.readFileSync(copyPath, 'utf8'),
                src,
                file + ' 副本与源不一致（跑 node scripts/sync-link-protocol.mjs）',
            );
        }
    });
}

test('dsh-desktop 仓库里的分发副本与规范源一致', () => {
    // 规范源在 dsh-android/desktop-plugins，分发副本在 dsh-desktop/resources/dsh-plugins。
    // 两边不一致的表现是「功能时好时坏」，最难查，所以逐字节比对。
    // 找不到 dsh-desktop 仓库时跳过（不是所有机器上都有这个仓库）。
    // 默认取仓库的同级目录 —— 不写死作者机器上的路径。
    const repo = process.env.DSH_DESKTOP_REPO ?? path.resolve(ROOT, '..', 'dsh-desktop');
    const copy = path.join(repo, 'resources/dsh-plugins/link');
    if (!fs.existsSync(copy)) {
        console.log('  （跳过：找不到 ' + copy + '）');
        return;
    }
    const src = path.join(ROOT, 'desktop-plugins/@dsh-desktop/link');
    const walk = (dir, prefix = '') => {
        const out = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? prefix + '/' + e.name : e.name;
            if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
            else out.push(rel);
        }
        return out;
    };
    const files = walk(src);
    assert.ok(files.length >= 6, '规范源文件数异常');
    for (const rel of files) {
        const a = fs.readFileSync(path.join(src, rel), 'utf8');
        const bPath = path.join(copy, rel);
        assert.ok(fs.existsSync(bPath), '分发副本缺 ' + rel + '（跑 node scripts/sync-desktop-plugin.mjs）');
        assert.equal(fs.readFileSync(bPath, 'utf8'), a, rel + ' 分发副本与规范源不一致（跑 node scripts/sync-desktop-plugin.mjs）');
    }
});

test('两端插件都不依赖安装期包管理器', () => {
    // 手机端在 nodejs-mobile 里跑、桌面端由外壳整体落位，两端都不能 npm install。
    // 所以除 node: 内置与已知的宿主提供包之外，不该出现裸包依赖。
    const allowed = new Set(['@deepseek-ai/dsh-tools', '@dsh-android/mobile-use', '@deepseek-ai/cordis']);
    for (const dir of [
        path.join(ROOT, 'plugins/@dsh-android/link'),
        path.join(ROOT, 'desktop-plugins/@dsh-desktop/link'),
    ]) {
        const entries = fs.readdirSync(path.join(dir, 'lib'), { withFileTypes: true });
        for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith('.js')) continue;
            const text = fs.readFileSync(path.join(dir, 'lib', e.name), 'utf8');
            for (const m of text.matchAll(/from '([^']+)'/g)) {
                const spec = m[1];
                if (spec.startsWith('.') || spec.startsWith('node:')) continue;
                assert.ok(allowed.has(spec), '未预期的裸包依赖 ' + spec + '（在 ' + e.name + '）');
            }
        }
    }
});
