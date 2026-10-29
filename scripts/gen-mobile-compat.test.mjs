/**
 * `gen-mobile-compat.mjs` 的端到端测试。
 *
 * ── 为什么需要这个测试 ──────────────────────────────────────────────────────
 * 手机端这条路径在真实数据上**恒为 0 条豁免**：随包 5 个插件声明的 peer 全是
 * `*`，怎么判都是 native。也就是说「豁免真被写出来」这件事，靠仓库里的真实
 * 插件永远验证不到 —— 生成器写错字段、写错键格式、把 unverified 也算进去，
 * 跑一遍照样输出 `{}`，看起来一切正常。
 *
 * 而 dsh 的 `readProfileCompatibility` 只认**精确** `name@version` 与精确
 * 宿主版本，写错一点就整条丢弃。所以必须用构造的运行时 + 构造的插件，把
 * 「bridged → 写豁免」「blocked → 构建失败」「unverified → 也写」
 * 「native → 不写」几条路都走过一遍。
 *
 * 跑：node --test scripts/gen-mobile-compat.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN = path.join(ROOT, 'scripts', 'gen-mobile-compat.mjs');
const HOST = '0.2.1-rc.4';

/** 造一个最小的「展开的运行时」：只有真正会跑到的两个包。 */
function makeRuntime(dir) {
    const nm = path.join(dir, 'node_modules', '@deepseek-ai');
    const pkg = (name, extra = {}) => {
        const d = path.join(nm, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
            name: `@deepseek-ai/${name}`, version: HOST, main: 'index.js', ...extra,
        }));
        return d;
    };
    const dsh = pkg('dsh');
    fs.writeFileSync(path.join(dsh, 'index.js'), 'export const createApp = () => {};\n');
    const tools = pkg('dsh-tools');
    // 只导出两个名字：`defineTool` 活到 0.2.1，`legacyHook` 是构造出来的「已删除符号」。
    fs.writeFileSync(path.join(tools, 'index.js'), 'export function defineTool() {}\nexport const ToolContext = {};\n');
    return dir;
}

/**
 * 造一个插件目录。
 *
 * ⚠️ 目录名**不能**以 `@` 开头：生成器把 `@` 开头的目录当成 scope 目录，
 * 会往下一层找包（真实布局是 `plugins/@dsh-android/link`）。夹具目录名带 `@`
 * 会被当成 scope，扫不到任何包，于是「扫描 0 个插件」静默通过 —— 第一版
 * 测试就是这么写错的。
 */
function makePlugin(base, name, { dirName, engines = '^0.1.5', files = {}, manifest = {} } = {}) {
    const dir = path.join(base, dirName ?? name.replace(/[/@]/g, '_'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name, version: '1.0.0', ...(engines === null ? {} : { engines: { dsh: engines } }), ...manifest,
    }, null, 2));
    for (const [rel, text] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
    }
    return dir;
}

function run(args) {
    return spawnSync(process.execPath, [GEN, ...args], { cwd: ROOT, encoding: 'utf8' });
}

/** 建一套临时环境，返回常用路径。 */
function setup() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-gen-'));
    const rt = makeRuntime(path.join(tmp, 'rt'));
    return { tmp, rt, out: path.join(tmp, 'out', 'compatibility.json') };
}

test('bridged：版本不满足但用到的包与符号都还在 → 写出精确豁免', () => {
    const { tmp, rt, out } = setup();
    const plug = makePlugin(tmp, '@t/good', { dirName: 'good',
        files: { 'index.js': "import { defineTool } from '@deepseek-ai/dsh-tools';\nexport const t = defineTool;\n" },
    });

    const r = run(['--runtime', rt, '--plugin-dir', plug, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /bridged=1/, '结论应当是 bridged：' + r.stdout);

    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    // 键必须是精确 name@version，值必须是精确宿主版本 —— 少一个字符，dsh 的
    // readProfileCompatibility 就会把整条丢掉，而且不报错。
    assert.deepEqual(written, { '@t/good@1.0.0': [HOST] });
});

test('blocked（符号被删）：退出码 1，且不写出任何文件', () => {
    const { tmp, rt, out } = setup();
    const plug = makePlugin(tmp, '@t/broken', { dirName: 'broken',
        files: { 'index.js': "import { legacyHook } from '@deepseek-ai/dsh-tools';\nexport const h = legacyHook;\n" },
    });

    const r = run(['--runtime', rt, '--plugin-dir', plug, '--out', out]);
    assert.equal(r.status, 1, '有内置插件跑不起来时必须让构建失败：' + r.stdout);
    assert.match(r.stdout + r.stderr, /legacyHook/, '报错要点出缺哪个符号');
    assert.equal(fs.existsSync(out), false, '判定失败时不能留下一个「看起来正常」的豁免文件');
});

test('blocked（包没了）：退出码 1', () => {
    const { tmp, rt, out } = setup();
    const plug = makePlugin(tmp, '@t/webhooky', { dirName: 'webhooky',
        files: { 'index.js': "import { on } from '@deepseek-ai/dsh-webhook';\nexport const x = on;\n" },
    });

    const r = run(['--runtime', rt, '--plugin-dir', plug, '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /dsh-webhook/);
    assert.equal(fs.existsSync(out), false);
});

test('unverified（纯客户端插件）：也写豁免 —— 「查不到」不是「跑不了」', () => {
    const { tmp, rt, out } = setup();
    // 逻辑全在浏览器侧：Node 永远查不到 dsh-client-store，所以判不了。
    //
    // 旧行为是「判不了就不放行」，理由是「否则等于兼容层对所有主题插件失效」。
    // 但那是把两个方向搞反了：不写豁免 = dsh 的 gate 直接拒绝加载这个插件，
    // 主题类插件（生态里数量最多的一类）一个都装不上。而写进去以后真出问题，
    // 坏的也只是它自己那块界面，宿主照常起来。
    //
    // 唯一仍然硬拦的是 blocked（静态能证明确实缺包/缺符号）。
    const plug = makePlugin(tmp, '@t/theme', { dirName: 'theme',
        manifest: { dsh: { client: { entry: 'client/index.js', inject: ['dsh-client-store'] } } },
        files: {
            'client/index.js': "import { store } from '@deepseek-ai/dsh-client-store';\nexport const s = store;\n",
        },
    });

    const r = run(['--runtime', rt, '--plugin-dir', plug, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /unverified=1/, r.stdout);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(written), ['@t/theme@1.0.0'], '应当为纯客户端插件写一条精确豁免');
    assert.deepEqual(written['@t/theme@1.0.0'], [HOST]);
});

test('native：版本声明本来就满足 → 不算豁免（不能白送一条）', () => {
    const { tmp, rt, out } = setup();
    const plug = makePlugin(tmp, '@t/fresh', { dirName: 'fresh',
        engines: '^0.2.0',
        files: { 'index.js': "import { defineTool } from '@deepseek-ai/dsh-tools';\nexport const t = defineTool;\n" },
    });

    const r = run(['--runtime', rt, '--plugin-dir', plug, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /native=1/, r.stdout);
    // 关键：native 不该产生豁免。写了也不会出错，但会让 compatibility.json
    // 里堆满没意义的条目，等真出问题时没人看得出哪条是救命的。
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {});
});

test('同一插件的源与副本（同 name@version）只算一次', () => {
    const { tmp, rt, out } = setup();
    const a = makePlugin(path.join(tmp, 'a'), '@t/dup', { dirName: 'dup',
        files: { 'index.js': "import { defineTool } from '@deepseek-ai/dsh-tools';\nexport const t = defineTool;\n" },
    });
    const b = makePlugin(path.join(tmp, 'b'), '@t/dup', { dirName: 'dup',
        files: { 'index.js': "import { defineTool } from '@deepseek-ai/dsh-tools';\nexport const t = defineTool;\n" },
    });

    const r = run(['--runtime', rt, '--plugin-dir', a, '--plugin-dir', b, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /扫描 1 个插件/, '按 name@version 去重后只应剩一个：' + r.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { '@t/dup@1.0.0': [HOST] });
});

test('缺运行时：报错并给出下一步，而不是崩在 require 上', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-nort-'));
    const out = path.join(tmp, 'out.json');
    const r = run(['--runtime', path.join(tmp, 'nope'), '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pack-runtime/);
    assert.equal(fs.existsSync(out), false);
});
