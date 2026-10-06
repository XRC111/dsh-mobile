/**
 * 端到端参数契约测试。
 *
 * 链路是五段：桌面工具 → 协议帧 → 手机 serve → mobile-use → Kotlin 无障碍服务。
 * 任何一段改了参数名而另一段没跟上，就出现「值被静默丢弃」——
 * 表现是键名变空（报"未知按键：（空）"）或报"swipe 需要 x1/y1/x2/y2"，极难自查。
 *
 * 这里从**真实的两个插件**取 serve 处理器与发送代码，断言每一段用的参数名
 * 和 Kotlin 服务实际读取的一致。
 *
 * 跑法：node scripts/link-contract.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const phoneSrc = fs.readFileSync(path.join(ROOT, 'plugins/@dsh-android/link/lib/index.js'), 'utf8');
const deskSrc = fs.readFileSync(path.join(ROOT, 'desktop-plugins/@dsh-desktop/link/lib/index.js'), 'utf8');
const mobileUseSrc = fs.readFileSync(path.join(ROOT, 'plugins/@dsh-android/mobile-use/lib/index.js'), 'utf8');

test('手机 serve 的参数名与 Kotlin 服务一致', () => {
    // Kotlin globalKey() 读 args.name；swipe() 读 x1/y1/x2/y2。
    assert.match(phoneSrc, /conn\.handle\('mobile\.key',\s*\(\{\s*name\s*\}/,
        "mobile.key 必须收 { name } —— 传 keys 会得到空键名");
    assert.match(phoneSrc, /conn\.handle\('mobile\.scroll',\s*\(\{\s*x1,\s*y1,\s*x2,\s*y2\s*\}/,
        'mobile.scroll 必须收四个坐标 —— Kotlin 的 swipe() 要 x1/y1/x2/y2');
    // 且必须原样透传给 bridge，不��再包一层自定义形状。
    assert.match(phoneSrc, /mobileCall\('key',\s*\{\s*name\s*\}/,
        'mobile.key 必须把 { name } 原样交给 mobile-use');
    assert.match(phoneSrc, /mobileCall\('swipe',\s*\{\s*x1,\s*y1,\s*x2,\s*y2\s*\}/,
        'mobile.scroll 必须把四个坐标原样交给 mobile-use');
});

test('桌面 phone_key 发 { name }', () => {
    assert.match(deskSrc, /\.call\('mobile\.key',\s*\{\s*name\s*\}/,
        '桌面必须发 { name }，不能发 { keys: [...] }');
});

test('桌面 phone_scroll 先取屏幕尺寸再换算成坐标', () => {
    const start = deskSrc.indexOf("name: 'phone_scroll'");
    const seg = deskSrc.slice(start, start + 2000);
    assert.match(seg, /mobile\.status/, 'phone_scroll 应先取屏幕尺寸');
    assert.match(seg, /\.call\('mobile\.scroll',\s*\{[^}]*x1[^}]*y1[^}]*x2[^}]*y2/s,
        'phone_scroll 必须发 x1/y1/x2/y2');
    assert.match(seg, /Math\.max\(0,\s*Math\.min\(/, '换算后的 y2 应 clamp 到屏内');
});

test('mobile-use 侧：key_press 读 name、mouse_scroll 算坐标', () => {
    assert.match(mobileUseSrc, /call\('key',\s*\{\s*name:/, 'mobile-use 的 key_press 读 args.name');
    assert.match(mobileUseSrc, /call\('swipe',\s*\{[\s\S]{0,120}x1:/, 'mobile-use 的 mouse_scroll 算好坐标后发 swipe');
});

test('调用方不会调到对端没 serve 的方法', () => {
    // 字符类用 [^']+：早先写成 [A-Za-z.]+ 时漏掉了带下划线的方法，
    // 这个测试反而"通过"了 —— 那次是我自己的检查工具出错。
    const served = (src) => new Set([...src.matchAll(/conn\.handle(?:Stream)?\(\s*'([^']+)'/g)].map((m) => m[1]));
    const called = (src) => new Set([...src.matchAll(/\.call(?:Stream)?\(\s*'([^']+)'/g)].map((m) => m[1]));
    const phoneServe = served(phoneSrc);
    const deskServe = served(deskSrc);
    const missingOnPhone = [...called(deskSrc)].filter((m) => m.startsWith('mobile.') && !phoneServe.has(m));
    const missingOnDesk = [...called(phoneSrc)].filter((m) => m.startsWith('computer.') && !deskServe.has(m));
    assert.deepEqual(missingOnPhone, [], '桌面会调、但手机没 serve：' + missingOnPhone.join(', '));
    assert.deepEqual(missingOnDesk, [], '手机会调、但桌面没 serve：' + missingOnDesk.join(', '));
});
