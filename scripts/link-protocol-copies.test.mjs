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
// mesh 三件套也在其中：deviceId 算法与拨号仲裁必须两端一致，
// 否则会出现「两边都以为自己该拨」→ 重复连接。
const FILES = [
    'protocol.js',
    'connection.js',
    'endpoint.js',
    'secret.js',
    'mesh-identity.js',
    'mesh-registry.js',
    'mesh-manager.js',
];
const TARGETS = [
    path.join(ROOT, 'desktop-plugins/@dsh-desktop/link/lib/link-protocol'),
    path.join(ROOT, 'plugins/@dsh-android/link/lib/link-protocol'),
];

/**
 * 桌面分发副本里**由 dsh-desktop 自己维护**、不该与规范源逐字节相同的文件。
 *
 * ⚠️ 当前是空集，请保持为空。这个清单存在过一版，当时把 lib/easytier.js
 *    排除在外，理由是「两端实现必然不同（手机 JNI / 桌面 FFI）」。
 *    实际核对后是错的：
 *      · 这个插件目录（desktop-plugins/@dsh-desktop/link）本来就**只服务桌面**，
 *        手机侧的实现另有 plugins/@dsh-android/link，两边从不需要共用一个文件；
 *      · dsh-desktop 里没有任何 easytier 实现，而 lib/index.js 直接
 *        `import * as et from './easytier.js'` —— 排除同步的后果是
 *        ERR_MODULE_NOT_FOUND，整个插件加载失败、设置页白屏。
 *    实测确认过（用桩包隔离宿主依赖后 import）。
 *
 * 加进这里的唯一判据：**同一份代码在同一个目录里不可能同时成立**。
 * 「桌面端还没做」、「两端实现不同」都不是理由。
 */
const DESKTOP_LOCAL_ONLY = new Set([]);

/** 比较两个 x.y.z 版本号：a>b → 1，a<b → -1，相等 0。无法解析按 0。 */
function cmpVer(a, b) {
    const pa = String(a).match(/^(\d+)\.(\d+)\.(\d+)/);
    const pb = String(b).match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!pa || !pb) return 0;
    for (let i = 1; i <= 3; i++) {
        const d = Number(pa[i]) - Number(pb[i]);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

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
    // 反向校验：清单里写了一个规范源并不存在的路径，说明文件被删了而清单没跟上 ——
    // 那样这个文件就永久脱离了校验（不报错、也不再比对）。宁可红一次。
    for (const rel of DESKTOP_LOCAL_ONLY) {
        assert.ok(fs.existsSync(path.join(src, rel)), '本地专属清单里的 ' + rel + ' 在规范源里不存在了（清单过期？）');
    }
    for (const rel of files) {
        if (DESKTOP_LOCAL_ONLY.has(rel)) continue;
        const bPath = path.join(copy, rel);
        assert.ok(fs.existsSync(bPath), '分发副本缺 ' + rel + '（跑 node scripts/sync-desktop-plugin.mjs）');
        const a = fs.readFileSync(path.join(src, rel), 'utf8');
        const b = fs.readFileSync(bPath, 'utf8');
        if (rel === 'package.json') {
            // package.json 是**唯一一个两边本来就不该相同**的文件：副本会被
            // dsh-desktop/scripts/pack-all-plugins.mjs 注入 dshDesktopBuild 内容戳
            // 并按内容自动升 patch 版本（那是「这份内容重新打过包」的判据）。
            // 逐字节比它必然报错，而报错的修复方式不是改代码，是把它排除掉 ——
            // 早先没排除，于是每次跑 pack-all 之后这个测试就红一次，
            // 很容易被误当成「副本没同步成功」。
            //
            // 这里改验真正该保证的东西：name 一致、版本**不倒退**，
            // 外加「除版本与内容戳之外，其余字段必须一致」——
            // 只查 name 太松了：exports / dsh.client.inject 这些字段一旦两边不同，
            // 表现同样是「功能时好时坏」（比如桌面侧少了某个 inject，设置页那一节
            // 静默不渲染），而版本号看起来完全正常。
            const pa = JSON.parse(a);
            const pb = JSON.parse(b);
            assert.equal(pb.name, pa.name, '分发副本的 name 与规范源不一致');
            assert.ok(
                cmpVer(pb.version, pa.version) >= 0,
                `分发副本版本 ${pb.version} 低于规范源 ${pa.version}（版本倒退）`,
            );
            // 剔除两个本来就该变的字段后逐键比对。
            const strip = (o) => {
                const c = { ...o };
                delete c.version;
                delete c.dshDesktopBuild;
                return JSON.stringify(c, Object.keys(c).sort());
            };
            assert.equal(
                strip(pb),
                strip(pa),
                '分发副本 package.json 除版本/内容戳外与规范源不一致（跑 node scripts/sync-desktop-plugin.mjs）',
            );
            continue;
        }
        assert.equal(b, a, rel + ' 分发副本与规范源不一致（跑 node scripts/sync-desktop-plugin.mjs）');
    }
});

test('桌面分发副本的内部 import 全都能解析到文件', () => {
    // ⚠️ 这条是上面那个「逐文件比对」查不到的盲区补丁：
    //    比对只遍历**规范源里有的文件**，而「桌面侧 import 了一个规范源里
    //    没有的东西」不在遍历范围里 —— 那种情况下副本缺文件，但因为源里也没有，
    //    测试完全看不见。而后果是最严重的：ERR_MODULE_NOT_FOUND，
    //    整个插件加载失败，设置页白屏。
    //
    //    真实踩过：lib/index.js import './easytier.js'，而同步清单里漏了它。
    const repo = process.env.DSH_DESKTOP_REPO ?? path.resolve(ROOT, '..', 'dsh-desktop');
    const copy = path.join(repo, 'resources/dsh-plugins/link');
    if (!fs.existsSync(copy)) {
        console.log('  （跳过：找不到 ' + copy + '）');
        return;
    }
    const walk = (dir, prefix = '') => {
        const out = [];
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? prefix + '/' + e.name : e.name;
            if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
            else if (e.name.endsWith('.js')) out.push(rel);
        }
        return out;
    };
    const missing = [];
    for (const rel of walk(copy)) {
        const text = fs.readFileSync(path.join(copy, rel), 'utf8')
            // 先剥注释：代码里存在 `import ... from './x.js'` 出现在
            // **注释**里的情况（比如 ERR_MODULE_NOT_FOUND 的报错样例），
            // 直接正则扫描会把它当成真导入 —— 本断言第一次跑就是这么误报的。
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
        // 只认相对导入；裸包名由宿主提供，这里管不着。
        for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
            const target = path.resolve(path.dirname(path.join(copy, rel)), m[1]);
            if (!fs.existsSync(target)) missing.push(rel + ' → ' + m[1]);
        }
    }
    assert.deepEqual(missing, [], '桌面分发副本里有解析不到的 import（同步清单漏了文件？）：\n  ' + missing.join('\n  '));
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
