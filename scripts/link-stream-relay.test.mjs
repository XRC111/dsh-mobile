/**
 * 流式中转（relay.stream）测试：**两台连不上彼此的设备，经 hub 转发流式模型请求**。
 *
 * ── 为什么要有这个测试 ──────────────────────────────────────────────────────
 * 之前只有 relay.call（走 `call`），非流式方法能中转、流式的不能 ——
 * 而模型转发 `llm.relay` 恰好是流式的。表现是「手机 A 让手机 B 调模型」永远
 * 失败，而同一对设备之间截图却正常，看起来像随机故障。
 *
 * 所以这里除了测「能用」，还重点测**安全边界与边界条件**：
 *   · 四道校验在流式路径上同样生效（只做一跳 / 白名单 / 不自转 / 目标在线）——
 *     校验被抽成 #checkRelay 共用，但「共用」本身也要验证真的共用了；
 *   · relay.stream 自身**不能**被再次转发（否则链式转发就有了口子）；
 *   · 块是**逐个**透传的，不是攒到最后一起给（那是「等半天整段蹦出来」）。
 *
 * 场景用真实 socket：流式中转的坑全在运行期状态上，mock 掉的正是要测的东西。
 *
 * 跑法：node scripts/link-stream-relay.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../packages/dsh-link-protocol/lib/mesh-registry.js';
import { LinkManager } from '../packages/dsh-link-protocol/lib/mesh-manager.js';
import { createIdentity, TOPOLOGY } from '../packages/dsh-link-protocol/lib/mesh-identity.js';
import { TRANSIT_METHOD, TRANSIT_STREAM_METHOD } from '../packages/dsh-link-protocol/lib/protocol.js';
import { relayStream } from '../packages/dsh-link-protocol/lib/llmrelay.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stream-relay-'));

/**
 * 建一台设备并起监听。
 *
 * @param {object} opts - { name, kind, capabilities }。
 * @returns {Promise<object>} { id, reg, mgr, port }。
 */
async function makeDevice({ name, kind, capabilities = [] }) {
    const home = tmp();
    const id = createIdentity(name, kind);
    const reg = new Registry(home, id.deviceId);
    const mgr = new LinkManager({
        deviceId: id.deviceId,
        identity: id,
        registry: reg,
        name,
        kind,
        capabilities,
        homeDir: home,
    });
    mgr.log = () => {};
    mgr.setTopology(TOPOLOGY.star);
    const started = await mgr.listen({ host: '127.0.0.1' });
    // ⚠️ name 必须一并返回：connectTo 要用它写进 client 的注册表。
    //    少了它，注册表里的 name 是 undefined，后续 find/展示全都不对，
    //    而且配对握手会拿到空名字 —— 表现为「连上了但设备名是空的」。
    return { id, reg, mgr, name, kind, port: started.port };
}

/** 让 client 连上 hub 并完成配对。 */
async function connectTo(hub, client) {
    client.reg.upsert({
        deviceId: hub.id.deviceId,
        name: hub.name,
        endpoint: '127.0.0.1:' + hub.port,
    });
    const conn = await client.mgr.dial(hub.id.deviceId, {
        force: true,
        code: hub.mgr.newPairCode(),
    });
    assert.ok(conn, 'client 应能连上 hub');
    return conn;
}

async function waitFor(label, fn, { timeoutMs = 5000, stepMs = 50 } = {}) {
    const t0 = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
        await new Promise((r) => setTimeout(r, stepMs));
    }
}

/**
 * 搭「hub + 两个 client」，两边只登记 hub 的地址 —— 彼此**没有**直连路径。
 *
 * @param {object} [opts] - { bCaps }：B 宣告的能力（默认含 llm.relay）。
 */
async function makeTriangle({ bCaps = ['llm.relay'] } = {}) {
    const hub = await makeDevice({ name: 'desk', kind: 'desktop', capabilities: ['computer.status'] });
    const a = await makeDevice({ name: 'phone-a', kind: 'mobile', capabilities: ['mobile.status'] });
    const b = await makeDevice({ name: 'phone-b', kind: 'mobile', capabilities: bCaps });
    await connectTo(hub, a);
    await connectTo(hub, b);
    await waitFor('hub 看到两台 client', () => hub.mgr.onlinePeers().length === 2);
    const close = () => {
        // ⚠️ 必须连 **server** 一起关：只 closeAll() 只断连接，监听 socket 还开着，
        //    node:test 跑完不会退出（表现为「测试全过但进程挂住」）。
        for (const d of [hub, a, b]) {
            try { d.mgr.closeAll(); } catch { /* ignore */ }
            const h = d.mgr.server;
            d.mgr.server = null;
            if (h) { try { void h.close(); } catch { /* ignore */ } }
        }
    };
    return { hub, a, b, close };
}

test('流式中转：两块都能经 hub 到达目标，块逐个透传', async (t) => {
    const tri = await makeTriangle();
    const { hub, a, b } = tri;
    t.after(tri.close);
    {
        const chunks = ['第一块', '第二块', '第三块'];
        const bConn = b.mgr.connectionTo(hub.id.deviceId);
        assert.ok(bConn, 'B 应有到 hub 的连接');
        bConn.handleStream('llm.relay', async (_args, emit) => {
            for (const c of chunks) {
                await new Promise((r) => setTimeout(r, 5));
                emit({ type: 'text', text: c });
            }
            emit({ type: 'finish', reason: { kind: 'stop' } });
        });

        // A 通过 hub 转发。
        const aToHub = a.mgr.connectionTo(hub.id.deviceId);
        assert.ok(aToHub, 'A 应有到 hub 的连接');

        const got = [];
        const result = await aToHub.callStream(
            TRANSIT_STREAM_METHOD,
            { to: b.id.deviceId, method: 'llm.relay', args: { prompt: 'hi' } },
            (c) => got.push(c),
            { timeoutMs: 20_000 },
        );

        // 只比 text 块的**内容与顺序**；finish 块没有 text 字段，
        // 混进 map 会得到 undefined 元素，让 deepEqual 必然失败。
        assert.deepEqual(
            got.filter((c) => c.type === 'text').map((c) => c.text),
            chunks,
            '经中转回来的块顺序与内容应与目标发出的一致',
        );
        assert.equal(got.length, chunks.length + 1, '应包含末尾的 finish 块');
        assert.equal(got.at(-1).type, 'finish');
        assert.ok(result !== undefined || result === null, '流结束时应返回目标的结果');
    }
});

test('流式中转：逐块到达而不是攒到最后', async () => {
    const t = await makeTriangle();
    try {
        const bConn = t.b.mgr.connectionTo(t.hub.id.deviceId);
        const arrived = [];
        bConn.handleStream('llm.relay', async (_args, emit, meta) => {
            for (let i = 0; i < 3; i += 1) {
                await new Promise((r) => setTimeout(r, 40));
                arrived.push(Date.now());
                emit({ type: 'text', text: '块' + i });
            }
            // ⚠️ finish 也要记：它同样经中转回吐，只把 text 记进 arrived 会让两边
            //    计数差 1，断言「中转不吞块也不重复」就变成误报。
            arrived.push(Date.now());
            emit({ type: 'finish', reason: { kind: 'stop' } });
        });

        const aToHub = t.a.mgr.connectionTo(t.hub.id.deviceId);
        const relayArrived = [];
        await aToHub.callStream(
            TRANSIT_STREAM_METHOD,
            { to: t.b.id.deviceId, method: 'llm.relay', args: {} },
            () => relayArrived.push(Date.now()),
            { timeoutMs: 20_000 },
        );

        assert.equal(relayArrived.length, arrived.length, '中转不应吞块或重复');
        // 逐块到达的判据：**前三个 text 块之间的间隔都明显大于 0**。
        //
        // ⚠️ 不要用「所有间隔的离散度 < 30ms」那种写法 —— finish 块是紧跟最后一个
        //    text 块到达的（它本来就该立刻到），那一段间隔必然接近 0，会把离散度
        //    拉大并造成误报。这里只取前三个 text 块。
        //
        // 若中转把块攒到最后一次性吐出，这三个间隔会全部接近 0。
        const textGaps = relayArrived.slice(1, 3).map((t2, i) => t2 - relayArrived[i]);
        assert.ok(
            textGaps.every((g) => g > 10),
            `text 块应逐个到达（每段间隔 >10ms），实测 ${textGaps.join(',')}`,
        );
    } finally {
        t.close();
    }
});

test('流式中转也受四道安全边界约束', async () => {
    const t = await makeTriangle();
    try {
        const aToHub = t.a.mgr.connectionTo(t.hub.id.deviceId);
        // ⚠️ 必须用 callStream，不能用 call：relay.stream 是**流式**方法，
        //    用 call 发过去会在协议层解码错位，报出来的却是
        //    「未提供方法 relay.stream」—— 把「调用方式错了」说成「对方没这个方法」，
        //    完全误导。（这条误报就是它逼出来的。）
        const call = (args) => aToHub.callStream(TRANSIT_STREAM_METHOD, args, () => {}, { timeoutMs: 10_000 })
            .then(() => null, (e) => String(e?.message ?? e));

        // 1) 缺 to
        assert.match(await call({ method: 'llm.relay' }), /需要 to/);
        // 2) 缺 method
        assert.match(await call({ to: t.b.id.deviceId }), /需要 method/);
        // 3) 自转
        assert.match(
            await call({ to: t.hub.id.deviceId, method: 'llm.relay' }),
            /转发到本机/,
        );
        // 4) 白名单：B 没宣告的方法
        assert.match(
            await call({ to: t.b.id.deviceId, method: 'never.announced' }),
            /未提供方法/,
        );
        // 5) 目标离线
        assert.match(
            await call({ to: 'ffffffffffffffff', method: 'llm.relay' }),
            /不在线/,
        );
    } finally {
        t.close();
    }
});

test('relay.stream 自身不能被再次转发（不许链式）', async () => {
    const t = await makeTriangle();
    try {
        const aToHub = t.a.mgr.connectionTo(t.hub.id.deviceId);
        const err = await aToHub.call(TRANSIT_METHOD, {
            to: t.b.id.deviceId,
            // 伪装成中转方法，看校验是否按 relay.* 前缀挡下
            method: TRANSIT_STREAM_METHOD,
            args: {},
        }, { timeoutMs: 10_000 }).then(() => null, (e) => String(e?.message ?? e));
        assert.match(err, /不支持链式转发/);
    } finally {
        t.close();
    }
});

test('能力宣告里 relay.call 与 relay.stream 都在', async () => {
    const t = await makeTriangle();
    try {
        const caps = t.hub.mgr.advertisedMethods();
        assert.ok(caps.includes(TRANSIT_METHOD), '应宣告 relay.call');
        assert.ok(caps.includes(TRANSIT_STREAM_METHOD), '应宣告 relay.stream');
        // ⚠️ 漏掉 relay.stream 的后果很隐蔽：非流式中转可用、流式中转找不到中转方，
        //    而模型转发正是流式的 —— 表现成「别的都能用就它不行」。
    } finally {
        t.close();
    }
});

test('中转方替请求方挑目标（__relayPreferRelay）', async () => {
    const t = await makeTriangle();
    try {
        // hub 连着 B（B 宣告了 llm.relay）。A 不指定目标，让 hub 自己挑。
        const bConn = t.b.mgr.connectionTo(t.hub.id.deviceId);
        bConn.handleStream('llm.relay', async (_args, emit) => {
            emit({ type: 'text', text: '来自B' });
            emit({ type: 'finish', reason: { kind: 'stop' } });
        });
        const aToHub = t.a.mgr.connectionTo(t.hub.id.deviceId);
        const got = [];
        await aToHub.callStream(
            TRANSIT_STREAM_METHOD,
            { args: { __relayPreferRelay: true, prompt: 'hi' } },
            (c) => got.push(c),
            { timeoutMs: 20_000 },
        );
        assert.equal(got[0]?.text, '来自B', 'hub 应挑到唯一宣告 llm.relay 的 B');

        // 标志不能带到目标那边去 —— 目标收到的是干净的请求。
        let seen = null;
        bConn.handleStream('llm.relay', async (args, emit) => {
            seen = args;
            emit({ type: 'finish', reason: { kind: 'stop' } });
        });
        await aToHub.callStream(
            TRANSIT_STREAM_METHOD,
            { args: { __relayPreferRelay: true } },
            () => {},
            { timeoutMs: 20_000 },
        );
        assert.ok(seen && seen.__relayPreferRelay === undefined, '__relayPreferRelay 不应转发给目标');
    } finally {
        t.close();
    }
});

test('relayStream 把回调式 call-stream 包成异步生成器', async () => {
    // 纯单元测试，不搭三方拓扑：这个包装器只依赖 conn.callStream，
    // 与角色、与拓扑都无关 —— 搭了真实连接反而把「测什么」变模糊了。
    const seen = [];
    const fake = {
        callStream(method, args, push) {
            seen.push({ method, args });
            push({ type: 'text', text: '一' });
            push({ type: 'text', text: '二' });
            push({ type: 'finish', reason: { kind: 'stop' } });
            return Promise.resolve({ ok: true });
        },
    };
    const got = [];
    for await (const c of relayStream(fake, { prompt: 'hi' }, 'test')) got.push(c);

    // 块的内容与顺序
    assert.deepEqual(
        got.filter((c) => c.type === 'text').map((c) => c.text),
        ['一', '二'],
    );
    assert.equal(got.length, 3, 'finish 块也要交回消费方');
    assert.equal(got.at(-1).type, 'finish');
    // 请求**原样**透传，不裁剪字段（裁剪会在插件注入自定义字段时静默丢东西）
    assert.equal(seen[0].method, 'llm.relay');
    assert.deepEqual(seen[0].args, { prompt: 'hi' });
});

test('relayStream 在对端出错时抛错，而不是当成正常结束', async () => {
    const fake = {
        callStream(_m, _a, _push) { return Promise.reject(new Error('对端炸了')); },
    };
    let caught = null;
    try {
        for await (const _ of relayStream(fake, {})) { /* 不会到这里 */ }
    } catch (e) { caught = e; }
    // 静默结束（不抛）会被 llm.stream 的消费方当成「模型返回空内容」，
    // 用户看到的是「答了个寂寞」而不是错误 —— 必须抛出来。
    assert.ok(caught, '对端失败应抛错');
    assert.match(String(caught.message), /对端炸了/);
});
