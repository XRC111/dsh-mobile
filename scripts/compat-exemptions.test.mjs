/**
 * 移动端兼容豁免落位的回归测试。
 *
 * 被测的是 launcher 里的 `installCompatExemptions` —— 它每次启动都会跑，
 * 而它操作的 `compatibility.json` 是 dsh 判断「这个插件能不能加载」的唯一依据。
 * 写坏的后果不是报错，是「明明授权过，重启又装不上」，所以必须钉住。
 *
 * 跑法：node scripts/compat-exemptions.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(ROOT, 'app/src/main/assets/nodejs-project/launcher.cjs');

// launcher 是 CJS，且在被 require 时会跳过 main()（见 EXPORT_ONLY）。
process.env.DSH_LAUNCHER_EXPORT_ONLY = '1';
const require = createRequire(import.meta.url);
const { installCompatExemptions } = require(LAUNCHER);

function fixture({ bundle = {}, existing = null } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-exempt-'));
    const bundleDir = path.join(root, 'bundle');
    const homeDir = path.join(root, 'dsh-home');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, 'profiles', 'web'), { recursive: true });
    if (bundle !== null) {
        fs.writeFileSync(path.join(bundleDir, 'compatibility.json'), JSON.stringify(bundle, null, 2));
    }
    if (existing !== null) {
        fs.writeFileSync(path.join(homeDir, 'profiles', 'web', 'compatibility.json'), existing);
    }
    return { root, bundleDir, homeDir, profile: path.join(homeDir, 'profiles', 'web', 'compatibility.json') };
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('没有随包豁免时不创建文件', () => {
    const f = fixture({ bundle: null });
    const r = installCompatExemptions(f.bundleDir, f.homeDir);
    assert.equal(r.written, false);
    assert.equal(fs.existsSync(f.profile), false, '不该凭空造一个空文件出来');
});

test('把随包豁免写进 profile', () => {
    const f = fixture({ bundle: { 'dsh-old@0.1.0': ['0.2.1-rc.4'] } });
    const r = installCompatExemptions(f.bundleDir, f.homeDir);
    assert.equal(r.written, true);
    assert.deepEqual(read(f.profile), { 'dsh-old@0.1.0': ['0.2.1-rc.4'] });
});

test('合并而不是覆盖：用户手写的授权必须留着', () => {
    // 这条是核心。整体覆盖等于把用户 `dsh plugin allow-version` 的结果抹掉，
    // 而症状是「重装 APK 之后插件又装不上了」，极难联想到是这里。
    const f = fixture({
        bundle: { 'new@1.0.0': ['0.2.1-rc.4'] },
        existing: JSON.stringify({ 'user-chosen@2.0.0': ['0.2.0-rc.2'] }),
    });
    installCompatExemptions(f.bundleDir, f.homeDir);
    assert.deepEqual(read(f.profile), {
        'new@1.0.0': ['0.2.1-rc.4'],
        'user-chosen@2.0.0': ['0.2.0-rc.2'],
    });
});

test('同一插件的多个宿主版本追加，不互相覆盖', () => {
    const f = fixture({
        bundle: { 'p@1.0.0': ['0.2.1-rc.4'] },
        existing: JSON.stringify({ 'p@1.0.0': ['0.2.0-rc.2'] }),
    });
    installCompatExemptions(f.bundleDir, f.homeDir);
    assert.deepEqual(read(f.profile)['p@1.0.0'], ['0.2.0-rc.2', '0.2.1-rc.4']);
});

test('内容没变化时不重写文件', () => {
    const f = fixture({
        bundle: { 'p@1.0.0': ['0.2.1-rc.4'] },
        existing: JSON.stringify({ 'p@1.0.0': ['0.2.1-rc.4'] }),
    });
    const before = fs.statSync(f.profile).mtimeMs;
    const r = installCompatExemptions(f.bundleDir, f.homeDir);
    assert.equal(r.written, false);
    assert.equal(fs.statSync(f.profile).mtimeMs, before, '没变就该跳过写盘');
});

test('现有文件读不动时保持原样，不覆盖', () => {
    // 坏文件不能把 profile 变砖，但也不能被我们「修」成空的 —— 那会丢授权。
    const f = fixture({
        bundle: { 'p@1.0.0': ['0.2.1-rc.4'] },
        existing: '{ 这不是 JSON',
    });
    const r = installCompatExemptions(f.bundleDir, f.homeDir);
    assert.equal(r.written, false);
    assert.equal(fs.readFileSync(f.profile, 'utf8'), '{ 这不是 JSON');
});

test('随包文件损坏时不动 profile', () => {
    const f = fixture({ bundle: null, existing: JSON.stringify({ 'keep@1.0.0': ['0.2.1-rc.4'] }) });
    fs.writeFileSync(path.join(f.bundleDir, 'compatibility.json'), 'not json');
    const r = installCompatExemptions(f.bundleDir, f.homeDir);
    assert.equal(r.written, false);
    assert.deepEqual(read(f.profile), { 'keep@1.0.0': ['0.2.1-rc.4'] });
});
