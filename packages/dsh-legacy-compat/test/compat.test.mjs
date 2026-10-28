/**
 * 兼容层单测。
 *
 * 全部用**桩**，不依赖本机装了哪份 dsh 运行时 —— 兼容层的判定逻辑必须能在
 * 任何机器上复现，否则 CI 绿了本地红，等于没测。
 *
 * 真实插件的端到端验证放在 scripts/verify-legacy-compat.mjs（需要一份运行时）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { satisfies, isRange, compare, declaredLines } from '../lib/semver.mjs';
import { unmetRequirements, evaluate, explain, exemptionsFor, VERDICT } from '../lib/index.mjs';
import { scanPluginDir } from '../lib/scan.mjs';

// ── semver ───────────────────────────────────────────────────────────────────

test('semver：^ 在 0.x 上的上界是下一个 minor', () => {
    // 这条是「0.1.x 插件在 0.2 宿主上不兼容」的算术来源，判定全靠它。
    assert.equal(satisfies('0.2.1-rc.4', '^0.1.5'), false);
    assert.equal(satisfies('0.1.7-rc.2', '^0.1.5'), true);
    // 反直觉但正确：rc 版**小于**同号正式版，所以 0.1.5-rc.3 不满足 ^0.1.5
    // （node-semver 同样返回 false）。这条固定住，免得有人「顺手修」成 true。
    assert.equal(satisfies('0.1.5-rc.3', '^0.1.5'), false);
    assert.equal(satisfies('0.1.5-rc.3', '^0.1.5-rc.3'), true);
    assert.equal(satisfies('0.2.0-rc.1', '^0.1.5'), false);
    // 1.x 不存在这个特殊性
    assert.equal(satisfies('1.5.0', '^1.2.3'), true);
    assert.equal(satisfies('2.0.0', '^1.2.3'), false);
});

test('semver：pre 版本落在区间内要按纯比较处理（includePrerelease）', () => {
    assert.equal(satisfies('0.2.1-rc.4', '>=0.1.0 <0.3.0'), true);
    assert.equal(satisfies('0.2.1-rc.4', '>=0.2.1-rc.2'), true);
    assert.equal(satisfies('0.2.1-rc.4', '>=0.2.1-rc.4'), true);
    assert.equal(satisfies('0.2.1-rc.4', '>0.2.1-rc.4'), false);
    assert.equal(satisfies('0.2.1', '>=0.2.1-rc.4'), true);
});

test('semver：操作符后带空格、通配、或区间', () => {
    assert.equal(satisfies('0.2.1-rc.4', '>= 0.1.5'), true);
    assert.equal(satisfies('0.2.1-rc.4', '0.2.x'), true);
    assert.equal(satisfies('0.2.1-rc.4', '0.1.x'), false);
    assert.equal(satisfies('0.2.1-rc.4', '*'), true);
    assert.equal(
        satisfies('0.2.1-rc.4', '>=0.1.2-rc.1 <0.1.3-0 || >=0.1.3-rc.1 <0.2.0-0'),
        false,
        '0.2.1 不在任何一段 0.1.x 区间里',
    );
    assert.equal(
        satisfies('0.1.2-rc.1', '>=0.1.2-rc.1 <0.1.3-0 || >=0.1.3-rc.1 <0.2.0-0'),
        true,
    );
});

test('semver：无法解析的区间一律不满足（保守）', () => {
    // 拿不准就判不满足 —— 把不确定当满足，会让真正坏掉的插件混进来。
    assert.equal(satisfies('0.2.1-rc.4', 'latest'), false);
    assert.equal(satisfies('0.2.1-rc.4', ''), false);
    assert.equal(satisfies('0.2.1-rc.4', 'next'), false);
    assert.equal(isRange('^0.1.5'), true);
    assert.equal(isRange('latest'), false);
});

test('semver：pre 段比较遵循规范（数字段 < 非数字段）', () => {
    assert.equal(compare('1.0.0-alpha', '1.0.0-alpha.1'), -1);
    assert.equal(compare('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
    assert.equal(compare('1.0.0-beta.2', '1.0.0-beta.11'), -1);
    assert.equal(compare('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compare('0.2.1-rc.4', '0.2.1-rc.4'), 0);
});

test('semver：declaredLines 只认 ^ 与 ~', () => {
    assert.deepEqual(declaredLines('^0.1.5'), ['0.1']);
    assert.deepEqual(declaredLines('>=0.1.5 <0.2.0'), []);
    assert.deepEqual(declaredLines('^0.1.5 || ~0.2.1'), ['0.1', '0.2']);
});

// ── unmetRequirements：必须与 dsh 的 gate 同构 ──────────────────────────────

test('要求判定：engines.dsh 优先，且一旦存在就忽略所有 peer', () => {
    const manifest = {
        engines: { dsh: '>=0.2.1-0 <0.3.0' },
        peerDependencies: { '@deepseek-ai/dsh-session': '^0.1.0' },
    };
    // engines 满足 → 整体满足，哪怕 peer 不满足（dsh 就是这么写的）
    assert.deepEqual(unmetRequirements(manifest, '0.2.1-rc.4'), {});
});

test('要求判定：没有 engines 时，任一 dsh peer 不满足即整体不满足', () => {
    const manifest = {
        peerDependencies: {
            '@deepseek-ai/dsh-session': '^0.2.0',
            '@deepseek-ai/dsh-llm': '^0.1.5',
            'react': '^18.0.0',
        },
    };
    const unmet = unmetRequirements(manifest, '0.2.1-rc.4');
    assert.deepEqual(Object.keys(unmet), ['@deepseek-ai/dsh-llm'], 'react 不是宿主包，不该被算进来');
});

test('要求判定：workspace 协议视为当前运行时', () => {
    const manifest = { peerDependencies: { '@deepseek-ai/dsh-session': 'workspace:^' } };
    assert.deepEqual(unmetRequirements(manifest, '0.2.1-rc.4'), {});
});

test('要求判定：没有任何声明 → 满足', () => {
    assert.deepEqual(unmetRequirements({ name: 'x', version: '1.0.0' }, '0.2.1-rc.4'), {});
});

// ── 扫描 ────────────────────────────────────────────────────────────────────

function makePlugin(files, manifest = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-compat-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        type: 'module',
        ...manifest,
    }, null, 1));
    return dir;
}

test('扫描：注释里的 import 不算依赖', () => {
    // 真实代码里会用注释贴 ERR_MODULE_NOT_FOUND 的报错样例，
    // 不剥注释就会把示例当成真导入，凭空造出一个依赖。
    const dir = makePlugin({
        'lib/index.js': `
            // import { nope } from '@deepseek-ai/dsh-does-not-exist'
            /* import { alsoNope } from '@deepseek-ai/dsh-also-missing' */
            import { SessionId } from '@deepseek-ai/dsh-session'
            export function apply() {}
        `,
    });
    const scanned = scanPluginDir(dir);
    assert.deepEqual(scanned.hostImports.map((x) => x.package), ['@deepseek-ai/dsh-session']);
    assert.deepEqual(scanned.hostImports[0].symbols, ['SessionId']);
});

test('扫描：客户端代码与宿主代码分开，客户端不参与 Node 侧校验', () => {
    // dsh-dracula-theme 就是这个形状：host 侧空的 apply()，逻辑全在 ./client，
    // 客户端里 require 了 dsh-client-store。混在一起会把正常插件判成「缺包」。
    const dir = makePlugin({
        'lib/index.js': `export function apply() {}`,
        'lib/client.js': `
            const store = require('@deepseek-ai/dsh-client-store')
            const react = require('react')
            module.exports = { apply() {} }
        `,
    }, { exports: { '.': './lib/index.js', './client': './lib/client.js' }, dsh: { client: { inject: ['@deepseek-ai/dsh-client-store'] } } });

    const scanned = scanPluginDir(dir);
    assert.deepEqual(scanned.hostImports, [], '客户端 require 不该出现在宿主侧');
    assert.deepEqual(scanned.clientImports.map((x) => x.package), ['@deepseek-ai/dsh-client-store']);
    assert.deepEqual(scanned.clientInjects, ['@deepseek-ai/dsh-client-store']);
});

test('扫描：命名空间导入不产生符号清单', () => {
    const dir = makePlugin({
        'lib/index.js': `
            import * as tools from '@deepseek-ai/dsh-tools'
            export function apply() {}
        `,
    });
    const scanned = scanPluginDir(dir);
    assert.equal(scanned.hostImports[0].symbols, null, '命名空间导入无法逐符号判');
});

test('扫描：跳过 node_modules 与测试目录', () => {
    const dir = makePlugin({
        'lib/index.js': `import { SessionId } from '@deepseek-ai/dsh-session'`,
        'node_modules/x/index.js': `import { nope } from '@deepseek-ai/dsh-nope'`,
        'test/a.test.js': `import { nope2 } from '@deepseek-ai/dsh-nope2'`,
    });
    const scanned = scanPluginDir(dir);
    assert.deepEqual(scanned.hostImports.map((x) => x.package), ['@deepseek-ai/dsh-session']);
});

// ── 判定 ────────────────────────────────────────────────────────────────────

/** 桩 surface：packages 形如 { 'pkg': ['Sym1','Sym2'] | null }，null = 不可读。 */
function stubSurface(packages) {
    return {
        probe(pkg) {
            if (!(pkg in packages)) return { package: pkg, visible: false, error: 'MODULE_NOT_FOUND' };
            const symbols = packages[pkg];
            return { package: pkg, visible: true, symbols: symbols === null ? null : new Set(symbols) };
        },
    };
}

const LEGACY_MANIFEST = {
    name: 'legacy',
    version: '1.0.0',
    peerDependencies: { '@deepseek-ai/dsh-session': '^0.1.5-rc.3' },
};

test('判定：版本满足 → native，不再看源码', () => {
    const r = evaluate({
        manifest: { ...LEGACY_MANIFEST, peerDependencies: { '@deepseek-ai/dsh-session': '>=0.1.0' } },
        hostVersion: '0.2.1-rc.4',
    });
    assert.equal(r.verdict, VERDICT.NATIVE);
});

test('判定：没有源码可校验 → unverified，不能当成通过', () => {
    const r = evaluate({ manifest: LEGACY_MANIFEST, hostVersion: '0.2.1-rc.4' });
    assert.equal(r.verdict, VERDICT.UNVERIFIED);
    assert.match(r.note, /还没有插件源码/);
});

test('判定：包与符号都在 → bridged', () => {
    const r = evaluate({
        manifest: LEGACY_MANIFEST,
        hostVersion: '0.2.1-rc.4',
        scanned: { hostImports: [{ package: '@deepseek-ai/dsh-session', symbols: ['SessionId'], files: ['lib/index.js'] }], clientImports: [], clientInjects: [] },
        surface: stubSurface({ '@deepseek-ai/dsh-session': ['SessionId', 'Session'] }),
    });
    assert.equal(r.verdict, VERDICT.BRIDGED);
    assert.equal(r.checked, 1);
});

test('判定：包没了 → blocked，并带上「无替代」的人话说明', () => {
    const transitions = {
        removedPackages: [{
            package: '@deepseek-ai/dsh-webhook',
            removedAt: '0.2.0-rc.2→0.2.1-rc.4',
            repairedBy: null,
            note: 'webhook 子系统下线，没有替代包。',
        }],
    };
    const r = evaluate({
        manifest: { ...LEGACY_MANIFEST, peerDependencies: { '@deepseek-ai/dsh-webhook': '^0.1.5' } },
        hostVersion: '0.2.1-rc.4',
        scanned: { hostImports: [{ package: '@deepseek-ai/dsh-webhook', symbols: null, files: ['lib/index.js'] }], clientImports: [], clientInjects: [] },
        surface: stubSurface({}),
        transitions,
    });
    assert.equal(r.verdict, VERDICT.BLOCKED);
    assert.equal(r.gaps[0].noReplacement, true);
    assert.match(explain(r), /webhook 子系统下线/);
});

test('判定：包在但符号没了 → blocked，且只报缺的那几个', () => {
    const r = evaluate({
        manifest: LEGACY_MANIFEST,
        hostVersion: '0.2.1-rc.4',
        scanned: {
            hostImports: [{ package: '@deepseek-ai/dsh-session', symbols: ['SessionId', 'OldThing'], files: ['lib/index.js'] }],
            clientImports: [],
            clientInjects: [],
        },
        surface: stubSurface({ '@deepseek-ai/dsh-session': ['SessionId'] }),
    });
    assert.equal(r.verdict, VERDICT.BLOCKED);
    assert.deepEqual(r.gaps[0].symbols, ['OldThing']);
});

test('判定：符号表不可读时不判缺失（宁可放过，不可误杀）', () => {
    const r = evaluate({
        manifest: LEGACY_MANIFEST,
        hostVersion: '0.2.1-rc.4',
        scanned: { hostImports: [{ package: '@deepseek-ai/dsh-session', symbols: ['SessionId'], files: ['lib/index.js'] }], clientImports: [], clientInjects: [] },
        surface: stubSurface({ '@deepseek-ai/dsh-session': null }),
    });
    assert.equal(r.verdict, VERDICT.BRIDGED);
    assert.equal(r.checked, 1);
    assert.equal(r.unchecked[0].reason, 'unreadable');
});

test('判定：只有客户端依赖 → unverified（客户端模块表运行期才组成）', () => {
    const r = evaluate({
        manifest: LEGACY_MANIFEST,
        hostVersion: '0.2.1-rc.4',
        scanned: { hostImports: [], clientImports: [{ package: '@deepseek-ai/dsh-client-store', symbols: null, files: ['lib/client.js'] }], clientInjects: ['@deepseek-ai/dsh-client-store'] },
        surface: stubSurface({}),
    });
    assert.equal(r.verdict, VERDICT.UNVERIFIED);
    assert.match(r.note, /客户端/);
});

// ── 豁免 ────────────────────────────────────────────────────────────────────

test('豁免：只收 bridged，键必须是精确 name@version', () => {
    const entries = [
        { manifest: { name: 'a', version: '1.0.0' }, result: { verdict: VERDICT.BRIDGED } },
        { manifest: { name: 'b', version: '2.0.0' }, result: { verdict: VERDICT.UNVERIFIED } },
        { manifest: { name: 'c', version: '3.0.0' }, result: { verdict: VERDICT.BLOCKED } },
        { manifest: { name: 'd', version: '4.0.0' }, result: { verdict: VERDICT.NATIVE } },
    ];
    assert.deepEqual(exemptionsFor(entries, '0.2.1-rc.4'), { 'a@1.0.0': ['0.2.1-rc.4'] });
});

test('豁免：显式打开后才收 unverified', () => {
    const entries = [{ manifest: { name: 'b', version: '2.0.0' }, result: { verdict: VERDICT.UNVERIFIED } }];
    assert.deepEqual(exemptionsFor(entries, '0.2.1-rc.4', { includeUnverified: true }), { 'b@2.0.0': ['0.2.1-rc.4'] });
});

test('豁免：同一插件重复出现不重复记版本', () => {
    const entries = [
        { manifest: { name: 'a', version: '1.0.0' }, result: { verdict: VERDICT.BRIDGED } },
        { manifest: { name: 'a', version: '1.0.0' }, result: { verdict: VERDICT.BRIDGED } },
    ];
    assert.deepEqual(exemptionsFor(entries, '0.2.1-rc.4'), { 'a@1.0.0': ['0.2.1-rc.4'] });
});
