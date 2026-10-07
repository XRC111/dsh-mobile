/**
 * 桌面侧组网绑定的测试。
 *
 * ── 为什么用「假 koffi」而不是真 dll ────────────────────────────────────────
 * 真 dll 是 7MB 的 Rust 产物，还只在 Actions artifact 里，测它就得先下载 ——
 * 于是「跑测试」依赖「网络可用」，失败时也分不清是代码错还是网络抖。
 *
 * 这里用一个替身记录调用序列，验证的是**绑定层自己的逻辑**：
 *   · TOML 字段名与层级是否与源码一致
 *   · parse_config → run_network_instance 的顺序（反了会给出误导性报错）
 *   · 失败时是否取 get_error_msg 并把 Rust 字符串还回去
 *   · null 指针的处理（Rust 侧真的会返回 null）
 *
 * 签名与所有权语义无法在 Node 里验证 —— 那部分靠注释里逐个对应的
 * Rust 源码位置。真机跑通才算最终验证。
 *
 * 用法：node scripts/easytier-desktop.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIB = path.join(ROOT, 'desktop-plugins/@dsh-desktop/link/lib/easytier.js');

// ⚠️ 不要再自己数 pass/fail：node:test 的 `ℹ pass N / ℹ fail M` 才是权威的。
//    之前自己维护计数器，结果 `afterEach` 的失败钩子与 node:test 各数一遍，
//    输出出现「12 通过 / 12 失败」而真实是 12/0 —— 自己写的统计反而误导人。
//    要断言具体哪些用例失败，看输出里的 '✖ failing tests:'。

/**
 * 造一个假 koffi：记录调用，并按预设脚本返回。
 *
 * ⚠️ 形状必须与 koffi **3.x** 一致：`koffi.load(path)` 返回库句柄，
 *    函数用 `句柄.func('签名串')` 取 —— 不是 2.x 的
 *    `koffi.func(path, name, ret, args)`。替身跟着做错的话，
 *    测的就不是真代码路径了（这个坑真踩过：第一次写 2.x 形状，
 *    报 koffi.func is not a function，白查一轮）。
 *
 * @param {object} script 各种函数的返回值与副作用配置。
 */
function fakeKoffi(script = {}) {
    const calls = [];
    const handle = {
        func(sig) {
            const name = String(sig).match(/(\w+)\s*\(/)?.[1] ?? String(sig);
            return (...args) => {
                calls.push({ name, sig: String(sig), args });
                const impl = script[name];
                if (typeof impl === 'function') return impl(...args);
                if (impl !== undefined) return impl;
                if (name === 'parse_config' || name === 'run_network_instance') return 0;
                if (name === 'collect_network_infos') return null;
                if (name === 'get_error_msg') {
                    // out 槽（koffi.out(...) 的替身）带 value，Rust 侧写回指针。
                    const slot = args[0];
                    if (slot && '__out' in slot) slot.value = rustStr('');
                    else args[0][0] = null;
                }
                return undefined;
            };
        },
    };
    return {
        calls,
        koffi: {
            load: (path) => {
                calls.push({ name: 'load', args: [path] });
                return handle;
            },
            // lastError 用 koffi.out(koffi.pointer(koffi.char)) 造 out 槽。
            // 替身给最小等价实现：out 标记带 value。
            char: 'char',
            pointer: (t) => ({ __ptr: t }),
            out: (t) => ({ __out: t, value: null }),
        },
    };
}

/**
 * 造一个 Rust 返回的字符串。
 *
 * ⚠️ koffi 把 `char*` 返回值**自动解码成 JS 字符串**（已用 kernel32 的
 *    lstrcpyA 实测：返回 'EASYTIER-PROBE' 而非数字地址）。所以替身也该
 *    返回字符串 —— 之前返回带 toString 的对象，与真 koffi 行为不符，
 *    于是 takeRustString 的字符串分支根本没被测到。
 */
function rustStr(s) {
    return s;
}

// 测试用的占位 dll 路径：只需「存在」即可 —— 真正被调用的是假 koffi，
// koffi 不去碰这个文件的内容。
const FAKE_DLL = path.join(os.tmpdir(), 'dsh-easytier-test', 'libeasytier_ffi.dll');
fs.mkdirSync(path.dirname(FAKE_DLL), { recursive: true });
fs.writeFileSync(FAKE_DLL, 'placeholder');

async function withLib(script, fn) {
    // 每次跑都重载模块：lib 是模块级单例，跨用例复用会串状态。
    const { calls, koffi } = fakeKoffi(script);
    // 拦截 requireCjs('koffi')：这里不能真装 koffi。
    // ⚠️ 副本必须用 .mjs —— Node 按扩展名判定模块格式，
    //    写成 .tmp-test 会报 ERR_UNKNOWN_FILE_EXTENSION（测过一次）。
    const tmp = LIB.replace(/\.js$/, '.testcopy.mjs');
    const src = fs.readFileSync(LIB, 'utf8')
        .replace("koffi = requireCjs('koffi');", 'koffi = globalThis.__FAKE_KOFFI;');
    fs.writeFileSync(tmp, src);
    globalThis.__FAKE_KOFFI = koffi;
    // load() 需要先找到一个 dll 才会去取函数引用。用环境变量指到占位文件 ——
    // 比传 pluginRoot 更直接，也顺带验证了 DSH_EASYTIER_DLL 这条覆盖路径。
    const savedDll = process.env.DSH_EASYTIER_DLL;
    process.env.DSH_EASYTIER_DLL = FAKE_DLL;
    try {
        const mod = await import('file://' + tmp.replace(/\\/g, '/') + '?t=' + Math.random());
        await fn(mod, calls);
    } finally {
        globalThis.__FAKE_KOFFI = undefined;
        if (savedDll === undefined) delete process.env.DSH_EASYTIER_DLL;
        else process.env.DSH_EASYTIER_DLL = savedDll;
        fs.rmSync(tmp, { force: true });
    }
}

// ── 1. TOML 结构必须与 easytier-core v2.6.4 源码一致 ──────────────────────
test('TOML 字段名与层级符合源码', async () => {
    const { buildToml } = await import('file://' + LIB.replace(/\\/g, '/'));
    const toml = buildToml({
        networkName: 'dsh', networkSecret: 'sec',
        peerUri: 'tcp://1.2.3.4:11010', bindPort: 45731, dstAddr: '10.144.0.3:45731',
    });
    // ⚠️ 不加 ^…$ 锚点：TOML 是 \n 分隔的多行文本，JS 正则的 ^/$ 默认只匹配
//    整个字符串首尾（要 /^…$/m 才认行首行尾，但 m 在 CRLF 下又有别的讲究）。
//    这里要验的是「这段配置里出现了这个键值」，不需要锚点。
const checks = [
        [/\nnetwork_name = "dsh"\n/, 'network_identity.network_name'],
        [/\nnetwork_secret = "sec"\n/, 'network_identity.network_secret'],
        [/\nno_tun = true\n/, 'flags.no_tun'],
        [/\nipv4 = "10\.144\.0\.2\/24"\n/, '固定虚拟 IP（手机侧 dst_addr 指向它）'],
        [/\nbind_addr = "127\.0\.0\.1:45731"\n/, 'port_forwards.bind_addr'],
        [/\ndst_addr = "10\.144\.0\.3:45731"\n/, 'port_forwards.dst_addr'],
        [/\nproto = "tcp"\n/, 'proto 是字符串不是枚举数字'],
        [/\n\[network_identity\]\n/, '[network_identity] 段存在'],
        [/\n\[flags\]\n/, '[flags] 段存在'],
    ];
    const bad = checks.filter(([re]) => !re.test(toml)).map(([, n]) => n);
    // bind_addr 必须绑回环：绑 0.0.0.0 会把转发端口暴露给同网段任何人。
    if (/bind_addr = "0\.0\.0\.0/.test(toml)) bad.push('bind_addr 不能绑 0.0.0.0');
    assert.deepEqual(bad, [], '缺失或错误的字段：' + bad.join('、'));
});

test('peerUri 留空时不生成 [[peer]] 段', async () => {
    const { buildToml } = await import('file://' + LIB.replace(/\\/g, '/'));
    const toml = buildToml({
        networkName: 'n', networkSecret: 's', peerUri: '',
        bindPort: 1, dstAddr: 'x:1',
    });
    assert.ok(!/\[\[peer\]\]/.test(toml), '不该有 peer 段');
});

/**
 * withLib 的变体：加载后再回调。
 *
 * ⚠️ 必须这么做的原因：start() 与 status() 都对 `lib` 为空有守卫
 *    （「库不可用」/「未找到 dll」）。不先 load 就调它们根本走不到
 *    本来要验的分支 —— 用例会「通过」但验的是别的东西。
 *    踩过一次：期望「空错误信息的兜底文案」，实际拿到的是「库不可用」。
 */
async function withLoadedLib(script, fn) {
    return withLib(script, async (mod, calls) => {
        mod.load(null);
        return fn(mod, calls);
    });
}

// ── 2. 启动顺序 ────────────────────────────────────────────────────────────
test('先 parse_config 再 run_network_instance', async () => {
    await withLoadedLib({}, async (mod, calls) => {
        mod.start({
            networkName: 'n', networkSecret: 's',
            peerUri: 'tcp://1.2.3.4:1', bindPort: 45731, dstAddr: '10.144.0.3:45731',
        });
        // 滤掉 load：koffi.load 也被记录了，它发生在取函数之前，与顺序无关。
        const names = calls.map(c => c.name).filter(n => n !== 'load');
        assert.equal(names[0], 'parse_config', '第一个必须是 parse_config');
        assert.equal(names[1], 'run_network_instance');
    });
});

test('配置不合法时不启动实例，且错误来自 get_error_msg', async () => {
    let freed = 0;
    await withLoadedLib({
        parse_config: () => -1,
        get_error_msg: (slot) => { slot.value = rustStr('unknown field `no_tun`'); },
        free_string: () => { freed++; },
    }, async (mod, calls) => {
        const rc = mod.start({
            networkName: 'dsh', networkSecret: 'sec',
            peerUri: '', bindPort: 45731, dstAddr: '10.144.0.3:45731',
        });
        assert.equal(rc.ok, false);
        // 滤掉 load：它也进 calls，与「校验没过就不该启动实例」无关。
        const names = calls.map(c => c.name).filter(n => n !== 'load');
        assert.ok(!names.includes('run_network_instance'),
            '校验没过就不该启动实例');
        assert.match(rc.error, /unknown field/, '错误信息应来自 Rust 侧');
    });
});

test('run_network_instance 失败时也取 get_error_msg', async () => {
    await withLoadedLib({
        run_network_instance: () => -1,
        get_error_msg: (slot) => { slot.value = rustStr('bind failed: address in use'); },
        free_string: () => {},
    }, async (mod) => {
        mod.load(null);
        const r = mod.start({
            networkName: 'n', networkSecret: 's', peerUri: '', bindPort: 1, dstAddr: 'x:1',
        });
        assert.equal(r.ok, false);
        assert.match(r.error, /address in use/);
    });
});

// ── 3. Rust 字符串所有权：必须 free_string，否则泄漏 ───────────────────────
test('get_error_msg 取出的字符串必须交还（into_raw = 所有权转移）', async () => {
    let freed = 0;
    await withLoadedLib({
        parse_config: () => -1,
        get_error_msg: (slot) => { slot.value = rustStr('boom'); },
        free_string: () => { freed++; },
    }, async (mod) => {
        mod.start({ networkName: 'n', networkSecret: 's', peerUri: '', bindPort: 1, dstAddr: 'x:1' });
        assert.equal(freed, 1, 'Rust 用 CString::into_raw 返回，所有权已转移，必须还回去');
    });
});

test('get_error_msg 返回 null 时不调 free_string', async () => {
    let freed = 0;
    await withLoadedLib({
        parse_config: () => -1,
        get_error_msg: (slot) => { slot.value = null; },
        free_string: () => { freed++; },
    }, async (mod) => {
        // ⚠️ 必须先 load()：start() 对 lib 为 null 有守卫，会直接返回
        //    「库不可用」而根本走不到 parse_config —— 那样测的就不是本用例
        //    想验的「空错误信息怎么处理」。
        mod.load(null);
        const r = mod.start({ networkName: 'n', networkSecret: 's', peerUri: '', bindPort: 1, dstAddr: 'x:1' });
        assert.equal(r.ok, false);
        assert.match(r.error, /未知|配置不合法/, '空错误信息应有兜底文案，不能是空串');
        assert.equal(freed, 0, '空指针不该传给 free_string（Rust 侧对 null 是 no-op，但别依赖）');
    });
});

test('collect_network_infos 轮询也要还字符串（每秒轮一次，一天几万次）', async () => {
    let freed = 0;
    await withLoadedLib({
        collect_network_infos: () => rustStr(JSON.stringify({ map: {} })),
        free_string: () => { freed++; },
    }, async (mod) => {
        for (let i = 0; i < 50; i++) mod.status(null);
        assert.equal(freed, 50, '每次轮询都要还一次');
    });
});

// ── 4. 缺库时降级，不能让插件加载失败 ──────────────────────────────────────
test('找不到 dll 时返回不可用，而不是抛异常', async () => {
    const { isAvailable, load } = await import('file://' + LIB.replace(/\\/g, '/'));
    const saved = process.env.DSH_EASYTIER_DLL;
    delete process.env.DSH_EASYTIER_DLL;
    try {
        assert.equal(load('/nonexistent-path-xyz'), null);
        assert.equal(isAvailable('/nonexistent-path-xyz'), false);
    } finally {
        if (saved !== undefined) process.env.DSH_EASYTIER_DLL = saved;
    }
});

test('库缺失时 start 返回明确错误而不是崩', async () => {
    const { load, start } = await import('file://' + LIB.replace(/\\/g, '/'));
    const saved = process.env.DSH_EASYTIER_DLL;
    delete process.env.DSH_EASYTIER_DLL;
    try {
        load('/nonexistent-path-xyz');
        const r = start({ networkName: 'n', networkSecret: 's', peerUri: '', bindPort: 1, dstAddr: 'x:1' });
        assert.equal(r.ok, false);
        assert.match(r.error, /不可用|未随安装包/);
    } finally {
        if (saved !== undefined) process.env.DSH_EASYTIER_DLL = saved;
    }
});

// ── 5. status 的 JSON 解析必须容错 ─────────────────────────────────────────
test('collect_network_infos 返回垃圾 JSON 时 peers 退化为空数组', async () => {
    await withLoadedLib({
        collect_network_infos: () => rustStr('not json at all'),
        free_string: () => {},
    }, async (mod) => {
        const s = mod.status(null);
        assert.deepEqual(s.peers, [], '解析失败应退化成空数组，而不是抛异常把设置页搞崩');
    });
});

test('能解析出对端的虚拟 IP', async () => {
    const json = JSON.stringify({
        map: {
            'phone-1': {
                running: true,
                routes: [{ peer_id: { ipv4: '10.144.0.3' } }],
            },
        },
    });
    await withLoadedLib({
        collect_network_infos: () => rustStr(json),
        free_string: () => {},
    }, async (mod) => {
        const s = mod.status(null);
        assert.equal(s.peers.length, 1);
        assert.equal(s.peers[0].ipv4, '10.144.0.3');
        assert.equal(s.peers[0].running, true);
    });
});