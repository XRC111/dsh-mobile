/**
 * 中转（relay.call）测试：**两台连不上彼此的设备，经 hub 互通**。
 *
 * 这是 star 拓扑里唯一能让两台 client 互通的办法：它们都只连着 hub，
 * 彼此没有任何直连路径。文档里承诺过这个能力，但一直没实现 ——
 * 所以这里既测「能用」，也测**安全边界**（不许链式转发、不许越权调方法）。
 *
 * 场景用真实 socket 搭，不用 mock：中转的坑全在「谁连着谁」这种运行期状态上，
 * mock 掉的正是要测的东西。
 *
 * 跑法：node scripts/link-relay.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../packages/dsh-link-protocol/lib/mesh-registry.js';
import { LinkManager } from '../packages/dsh-link-protocol/lib/mesh-manager.js';
import { createIdentity, TOPOLOGY } from '../packages/dsh-link-protocol/lib/mesh-identity.js';
import { TRANSIT_METHOD } from '../packages/dsh-link-protocol/lib/protocol.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'link-relay-'));

/**
 * 建一台设备并起监听。
 *
 * ⚠️ `capabilities` 必须给出**真实**的业务方法清单：中转会按对端宣告的方法
 *    做白名单校验（「只转发目标宣告过的」）。不给的话对端只看到 relay.call，
 *    于是任何业务方法都会被拒 —— 那是**正确行为**，不是 bug。
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
    // 用 star 拓扑：这正是要测的场景（client 之间不直连）。
    mgr.setTopology(TOPOLOGY.star);
    const started = await mgr.listen({ host: '127.0.0.1' });
    return { id, reg, mgr, port: started.port };
}

/**
 * 让 client 连上 hub 并完成配对。
 *
 * @param {object} hub - hub 设备。
 * @param {object} client - client 设备。
 * @param {string} hubName - hub 在 client 注册表里的名字。
 * @returns {Promise<object>} 连接。
 */
async function connectTo(hub, client, hubName) {
    client.reg.upsert({
        deviceId: hub.id.deviceId,
        name: hubName,
        endpoint: '127.0.0.1:' + hub.port,
    });
    const conn = await client.mgr.dial(hub.id.deviceId, {
        force: true,
        code: hub.mgr.newPairCode(),
    });
    assert.ok(conn, 'client 应能连上 hub');
    return conn;
}

/** 等条件成立，超时给出可读原因。 */
async function waitFor(label, fn, { timeoutMs = 5000, stepMs = 50 } = {}) {
    const t0 = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - t0 > timeoutMs) throw new Error('等待超时：' + label);
        await new Promise((r) => setTimeout(r, stepMs));
    }
}

/**
 * 搭一个「hub + 两个 client」的三方场景。
 *
 * 两个 client 之间**没有**任何直连路径（star 拓扑 + 只登记 hub 的地址），
 * 这正是中转要解决的问题。
 *
 * @returns {Promise<object>} { hub, a, b, close }。
 */
async function makeTriangle() {
    // 手机侧宣告 mobile.*（真实的 MOBILE_CAPS 就是这些）。
    const mobileCaps = ['mobile.status', 'mobile.screen_shot', 'mobile.click'];
    const hub = await makeDevice({ name: 'desk', kind: 'desktop', capabilities: ['computer.status'] });
    const a = await makeDevice({ name: 'phone-a', kind: 'mobile', capabilities: mobileCaps });
    const b = await makeDevice({ name: 'phone-b', kind: 'mobile', capabilities: mobileCaps });

    await connectTo(hub, a, 'desk');
    await connectTo(hub, b, 'desk');
    // hub 侧等两条入站连接都登记好
    await waitFor('hub 看到两台 client', () => hub.mgr.onlinePeers().length === 2);

    return {
        hub, a, b,
        close: async () => {
            await a.mgr.stopAutoConnect();
            await b.mgr.stopAutoConnect();
            await hub.mgr.stopAutoConnect();
        },
    };
}

test('中转：两台互不直连的设备经 hub 互相调用', async (t) => {
    const { hub, a, b, close } = await makeTriangle();
    t.after(close);

    // 前提断言：a 与 b **确实**没有直连（否则这个测试就没测到中转）
    assert.equal(a.mgr.connectionTo(b.id.deviceId), null, 'a 不该直连 b');
    assert.equal(b.mgr.connectionTo(a.id.deviceId), null, 'b 不该直连 a');

    // hub 同时连着两台 —— 它才有资格当中转
    assert.ok(hub.mgr.connectionTo(a.id.deviceId), 'hub 连着 a');
    assert.ok(hub.mgr.connectionTo(b.id.deviceId), 'hub 连着 b');

    // b 在自己的连接上注册一个只有它才有的方法。
    //
    // ⚠️ 方向别搞反：`conn.handle(name, fn)` 注册的是「**对端**可以调用我的这个方法」。
    //    所以要在 b 那一侧的连接上注册（b 是拨号方，它持有 outbound 连接），
    //    而不是在 hub 侧那条连接上注册 —— 后者等于让 hub 提供这个方法。
    const bSide = b.mgr.connectionTo(hub.id.deviceId);
    assert.ok(bSide, 'b 应持有到 hub 的连接');
    bSide.handle('mobile.status', () => ({ who: 'phone-b', battery: 88 }));

    // a 侧经 hub 调 b：这正是 invokeWithRelay 走的那条路
    const viaHub = a.mgr.connectionTo(hub.id.deviceId);
    const result = await viaHub.call(TRANSIT_METHOD, {
        to: b.id.deviceId,
        method: 'mobile.status',
        args: {},
    }, { timeoutMs: 10_000 });

    assert.equal(result.who, 'phone-b', '应拿到 b 的返回，而不是 a 自己的或 hub 的');
    assert.equal(result.battery, 88);
});

test('中转：目标不在线时明确报错，不吞请求', async (t) => {
    const { hub, a, close } = await makeTriangle();
    t.after(close);

    const viaHub = a.mgr.connectionTo(hub.id.deviceId);
    await assert.rejects(
        () => viaHub.call(TRANSIT_METHOD, {
            to: 'ffffffffffffffff',   // 谁都不是
            method: 'mobile.status',
            args: {},
        }, { timeoutMs: 10_000 }),
        /不在线|not connected/i,
        '目标不在线应报错，而不是挂住或返回空',
    );
});

test('中转：只转发目标**宣告过**的方法（不能越权调任意方法）', async (t) => {
    const { hub, a, b, close } = await makeTriangle();
    t.after(close);

    // b 只宣告了 mobile.*，没宣告 computer.screen_shot（那是桌面侧的能力）。
    // 请求一个 b 没宣告的方法 → 必须被 hub 挡下，而不是照转过去。
    const viaHub = a.mgr.connectionTo(hub.id.deviceId);
    await assert.rejects(
        () => viaHub.call(TRANSIT_METHOD, {
            to: b.id.deviceId,
            method: 'computer.screen_shot',   // 手机侧不提供这个
            args: {},
        }, { timeoutMs: 10_000 }),
        /未提供方法|not provided/i,
        '未宣告的方法不该被转发',
    );
});

test('中转：拒绝链式转发（relay.* 不能被再次转发）', async (t) => {
    const { hub, a, b, close } = await makeTriangle();
    t.after(close);

    // 这条最关键：允许转发 relay.* 的话，A→B→C→… 会形成链条，
    // 延迟与排障都失控，还能被当放大器用。
    const viaHub = a.mgr.connectionTo(hub.id.deviceId);
    await assert.rejects(
        () => viaHub.call(TRANSIT_METHOD, {
            to: b.id.deviceId,
            method: TRANSIT_METHOD,   // 拿中转本身当中转目标
            args: { to: 'x', method: 'mobile.status' },
        }, { timeoutMs: 10_000 }),
        /链式|chain/i,
        'relay.* 必须被拒绝，只做一跳',
    );
});

test('中转：目标是自己时拒绝（绕圈子）', async (t) => {
    const { hub, a, close } = await makeTriangle();
    t.after(close);

    const viaHub = a.mgr.connectionTo(hub.id.deviceId);
    await assert.rejects(
        () => viaHub.call(TRANSIT_METHOD, {
            to: hub.id.deviceId,   // 让 hub 转发到 hub 自己
            method: 'mobile.status',
            args: {},
        }, { timeoutMs: 10_000 }),
        /转发到本机|itself/i,
        '不该允许转发到自己',
    );
});

test('中转：两端都宣告了 relay.call（否则调用方找不到中转方）', async (t) => {
    const { hub, a, close } = await makeTriangle();
    t.after(close);

    // 能力宣告是中转能被发现的**唯一**依据：调用方看 peerMethods 里有没有它。
    // 漏宣告的话功能「实现了但用不上」—— 这类错最难查，所以固化成断言。
    const viaHub = a.mgr.connectionTo(hub.id.deviceId);
    assert.ok(
        (viaHub.peerMethods ?? []).includes(TRANSIT_METHOD),
        'hub 必须向 client 宣告 relay.call，实际宣告了：' + (viaHub.peerMethods ?? []).join(', '),
    );
    // 反向：client 也要宣告（mesh 下手机可能成为中转方）
    const hubSide = hub.mgr.connectionTo(a.id.deviceId);
    assert.ok(
        (hubSide.peerMethods ?? []).includes(TRANSIT_METHOD),
        'client 也必须向 hub 宣告 relay.call',
    );
});
