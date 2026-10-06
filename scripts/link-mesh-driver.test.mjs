/**
 * mesh 自动连接驱动测试：**两端真的会自己连上**。
 *
 * 这测的不是「能力」（listen/dial 能不能用，那在 link-mesh-integration.test.mjs 里），
 * 而是「驱动有没有把它们跑起来」—— 补这块之前，mesh 拓扑切了也不会互连：
 * dialTargets() 只算出一份「该拨谁」的清单，没有任何东西去拨。
 *
 * 所以这里**不起定时器以外的任何人工干预**：建两台设备、都设成 mesh、各自
 * startAutoConnect，然后等它们自己连上。任何一边的驱动没接对，这个测试就红。
 *
 * 跑法：node scripts/link-mesh-driver.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../packages/dsh-link-protocol/lib/mesh-registry.js';
import { LinkManager } from '../packages/dsh-link-protocol/lib/mesh-manager.js';
import { createIdentity, TOPOLOGY } from '../packages/dsh-link-protocol/lib/mesh-identity.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'link-drv-'));

/**
 * 建一台设备（身份 + 注册表 + 管理器）。
 *
 * @param {object} opts - { name, kind }。
 * @returns {object} { id, reg, mgr, home }。
 */
function makeDevice({ name, kind }) {
    const home = tmp();
    const id = createIdentity(name, kind);
    const reg = new Registry(home, id.deviceId);
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg, name, kind, homeDir: home });
    return { id, reg, mgr, home };
}

/**
 * 让两台设备「配对过」：各自把对方登记进注册表，**并带上可用的令牌**。
 *
 * ⚠️ 这里必须走真实的配对流程（code → 拿 token），不能只登记 deviceId+endpoint：
 *    自动重连靠的是令牌，`authorize` 在没有 code 也没有 token 时会直接拒绝
 *    （bad token）。只登记地址的话，驱动会一直重试、一直失败 ——
 *    这正是第一版测试超时的原因，也是个容易误判成「驱动坏了」的坑。
 *
 * 做法：让「该拨的那一方」（deviceId 字典序小的）用配对码连一次，拿到令牌存进
 * 注册表；之后自动重连就能用令牌了。
 *
 * @param {object} a - 设备 A。
 * @param {object} b - 设备 B。
 * @param {number} aPort - A 的监听端口。
 * @param {number} bPort - B 的监听端口。
 */
async function pair(a, b, aPort, bPort) {
    // 双方先互相认识（地址），令牌稍后由配对流程写入。
    a.reg.upsert({ deviceId: b.id.deviceId, name: b.mgr.name, endpoint: '127.0.0.1:' + bPort });
    b.reg.upsert({ deviceId: a.id.deviceId, name: a.mgr.name, endpoint: '127.0.0.1:' + aPort });

    // 由「该拨的那一方」去配对 —— 它才需要令牌。
    const [dialer, target, targetPort] = a.id.deviceId < b.id.deviceId
        ? [a, b, bPort]
        : [b, a, aPort];

    const code = target.mgr.newPairCode();
    const conn = await dialer.mgr.dial(target.id.deviceId, { force: true, code });
    assert.ok(conn, '配对拨号应成功');
    assert.ok(conn.issuedToken, '配对后应拿到长期令牌');
    // dial() 内部已经把令牌写进注册表（见 mesh-manager 的 dial）；这里断言一下，
    // 因为自动重连完全依赖它 —— 漏写就退化成「每次重启都要重新配对」。
    const rec = dialer.reg.get(target.id.deviceId);
    assert.equal(rec.token, conn.issuedToken, '令牌必须写进注册表，否则自动重连没凭据');
    conn.close('paired');
    await new Promise((r) => setTimeout(r, 150));
}

/** 等到条件成立，或超时后失败（给出可读的原因，而不是干等）。 */
async function waitFor(label, fn, { timeoutMs = 8000, stepMs = 100 } = {}) {
    const t0 = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - t0 > timeoutMs) {
            throw new Error('等待超时（' + timeoutMs + 'ms）：' + label);
        }
        await new Promise((r) => setTimeout(r, stepMs));
    }
}

test('驱动：两端设成 mesh 后**自己**连上（无人干预）', async (t) => {
    const a = makeDevice({ name: 'desk', kind: 'desktop' });
    const b = makeDevice({ name: 'phone', kind: 'mobile' });
    t.after(async () => {
        await a.mgr.stopAutoConnect();
        await b.mgr.stopAutoConnect();
    });

    // 先各自监听（mesh 下每台都要监听），拿到端口才能互相登记。
    a.mgr.setTopology(TOPOLOGY.mesh);
    b.mgr.setTopology(TOPOLOGY.mesh);
    const as = await a.mgr.startAutoConnect({ intervalMs: 200 });
    const bs = await b.mgr.startAutoConnect({ intervalMs: 200 });
    assert.ok(as.listening && bs.listening, 'mesh 下两台都应监听');
    assert.ok(as.port > 0 && bs.port > 0, '两台都应拿到端口');

    // 走真实配对（拿到令牌）—— 之后自动重连才有凭据。
    await pair(a, b, as.port, bs.port);

    // 关键断言：等它们自己连上（无人干预，全靠驱动）。
    // 仲裁决定只有字典序小的一方拨，所以两边各有一条到对方的连接、方向相反。
    await waitFor('两端互相连上', () => {
        const aToB = a.mgr.connectionTo(b.id.deviceId);
        const bToA = b.mgr.connectionTo(a.id.deviceId);
        return Boolean(aToB && !aToB.closed && bToA && !bToA.closed);
    });

    // 只有一条链路：不该出现「两边各拨一条」的重复
    assert.equal(a.mgr.inbound.size + a.mgr.outbound.size, 1, 'A 侧到对端只应有一条连接');
    assert.equal(b.mgr.inbound.size + b.mgr.outbound.size, 1, 'B 侧到对端只应有一条连接');
    const aDir = a.mgr.inbound.has(b.id.deviceId) ? 'in' : 'out';
    const bDir = b.mgr.inbound.has(a.id.deviceId) ? 'in' : 'out';
    assert.notEqual(aDir, bDir, '同一条链路在两端的方向必须相反（否则是两条独立连接）');
});

test('驱动：断线后能**自己**重连（这是自动重连的真正意义）', async (t) => {
    const a = makeDevice({ name: 'desk', kind: 'desktop' });
    const b = makeDevice({ name: 'phone', kind: 'mobile' });
    t.after(async () => {
        await a.mgr.stopAutoConnect();
        await b.mgr.stopAutoConnect();
    });

    a.mgr.setTopology(TOPOLOGY.mesh);
    b.mgr.setTopology(TOPOLOGY.mesh);
    const as = await a.mgr.startAutoConnect({ intervalMs: 200 });
    const bs = await b.mgr.startAutoConnect({ intervalMs: 200 });
    await pair(a, b, as.port, bs.port);

    await waitFor('先连上', () => Boolean(a.mgr.connectionTo(b.id.deviceId)));

    // 人为切断：模拟网络抖动 / 对端重启。
    // ⚠️ 不要断言「切断后一段时间内仍断开」—— 驱动每 200ms 拨一次，那个窗口
    //    短到几乎必然已经重连上了（第一版就是这么写错的）。这里只记下「切断过」
    //    这个事实，然后验证它能恢复。
    const before = a.mgr.connectionTo(b.id.deviceId);
    before.close('test-cut');

    // 关键：驱动应该自己把它接回来，不需要任何人干预
    await waitFor('自己重连回来', () => {
        const c = a.mgr.connectionTo(b.id.deviceId);
        return Boolean(c && !c.closed && c !== before);
    }, { timeoutMs: 10_000 });
});

test('驱动：star 拓扑下不拨任何人、也不监听', async (t) => {
    const a = makeDevice({ name: 'desk', kind: 'desktop' });
    const b = makeDevice({ name: 'phone', kind: 'mobile', peerId: a.id.deviceId, peerName: 'desk', peerPort: 1 });
    t.after(async () => { await a.mgr.stopAutoConnect(); await b.mgr.stopAutoConnect(); });

    // 默认是 mesh，先显式切到 star —— 测的是 star 的语义。
    a.mgr.setTopology(TOPOLOGY.star);
    assert.equal(a.mgr.topology, TOPOLOGY.star);
    await a.mgr.startAutoConnect({ intervalMs: 150, listen: false });
    await new Promise((r) => setTimeout(r, 600));

    assert.deepEqual(a.mgr.dialTargets(), [], 'star 下不该有拨号目标');
    assert.equal(a.mgr.inbound.size + a.mgr.outbound.size, 0, 'star 下不该自己建连');
});

test('驱动：对端没起来时退避重试，不刷屏也不放弃', async (t) => {
    // ⚠️ 目标 deviceId 必须**保证比我大**，否则 shouldDial 会判定「不该我拨」，
    //    dialTargets 直接是空的 —— 那样测的就不是退避，而是仲裁了。
    //    用 'ffffffffffffffff' 是十六进制最大值，任何真实指纹都比它小。
    const ghostId = 'ffffffffffffffff';
    const a = makeDevice({ name: 'desk', kind: 'desktop' });
    t.after(async () => { await a.mgr.stopAutoConnect(); });
    assert.ok(a.id.deviceId < ghostId, '前提：本机 id 应小于 ' + ghostId);

    // 指向一个没人监听的端口（1 号端口普通用户连不上 → 稳定失败）
    a.reg.upsert({ deviceId: ghostId, name: 'ghost', endpoint: '127.0.0.1:1' });

    const logs = [];
    a.mgr.log = (m) => logs.push(m);
    a.mgr.setTopology(TOPOLOGY.mesh);
    await a.mgr.startAutoConnect({ intervalMs: 120, listen: false });

    // 先确认它确实进了拨号目标（否则下面的断言没有意义）
    assert.deepEqual(a.mgr.dialTargets().map((r) => r.deviceId), [ghostId], '应把 ghost 列为拨号目标');

    await new Promise((r) => setTimeout(r, 1200));

    // 失败计数在涨（说明真的在重试）
    assert.ok(a.mgr.dialFailures.get(ghostId) >= 1,
        '应记录失败次数用于退避，实际 ' + JSON.stringify([...a.mgr.dialFailures]));
    // 但没有把每一次都打出来（前两次 + 每 5 次才报一次）
    const fails = logs.filter((l) => l.includes('自动连接') && l.includes('失败'));
    assert.ok(fails.length <= 3, '失败日志应被抑制，实际 ' + fails.length + ' 条：' + fails.join(' | '));
    // 也没建出连接
    assert.equal(a.mgr.connectionTo(ghostId), null);
});

test('驱动：stopAutoConnect 之后彻底安静（定时器与连接都收掉）', async (t) => {
    const a = makeDevice({ name: 'desk', kind: 'desktop' });
    const b = makeDevice({ name: 'phone', kind: 'mobile' });
    t.after(async () => { await a.mgr.stopAutoConnect(); await b.mgr.stopAutoConnect(); });

    a.mgr.setTopology(TOPOLOGY.mesh);
    b.mgr.setTopology(TOPOLOGY.mesh);
    const as = await a.mgr.startAutoConnect({ intervalMs: 200 });
    const bs = await b.mgr.startAutoConnect({ intervalMs: 200 });
    await pair(a, b, as.port, bs.port);

    await waitFor('先连上', () => Boolean(a.mgr.connectionTo(b.id.deviceId)));

    await a.mgr.stopAutoConnect();
    assert.equal(a.mgr.autoTimer, null, '定时器应被清掉');
    assert.equal(a.mgr.server, null, '监听应被关掉');
    assert.equal(a.mgr.inbound.size + a.mgr.outbound.size, 0, '连接应被关掉');
});

test('拓扑持久化：重启后仍是用户选的（否则用户会以为「设了没用」）', async () => {
    const home = tmp();
    const id = createIdentity('desk', 'desktop');
    const reg1 = new Registry(home, id.deviceId);
    // 默认是 mesh（超集语义：装了 overlay 开箱即用，没装的退化成 star 的可用性）
    assert.equal(reg1.topology, 'mesh', '默认应是 mesh');
    // 用户显式改成 star 也要记住
    reg1.setTopology('star');

    // 重新载入（模拟进程重启）
    const reg2 = new Registry(home, id.deviceId);
    assert.equal(reg2.topology, 'star', '拓扑必须落盘');

    // 管理器也要跟着恢复
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg2, homeDir: home });
    assert.equal(mgr.topology, TOPOLOGY.star, '管理器应从注册表恢复拓扑');
});

test('令牌持久化：重启后对方拿旧令牌仍能连（不必重新配对）', async () => {
    const home = tmp();
    const id = createIdentity('desk', 'desktop');
    const reg = new Registry(home, id.deviceId);
    const mgr1 = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg, homeDir: home });

    // 走一次配对码流程，拿到签发的令牌
    const code = mgr1.newPairCode();
    const r = mgr1.authorize({ code });
    assert.ok(r.ok && r.token, '应发放令牌');
    const token = r.token;

    // 重新载入（模拟进程重启）
    const mgr2 = new LinkManager({ deviceId: id.deviceId, identity: id, registry: new Registry(home, id.deviceId), homeDir: home });
    assert.equal(mgr2.authorize({ token }).ok, true, '重启后旧令牌必须仍然有效');

    // 对照：没落盘的令牌不该凭空出现
    const otherHome = tmp();
    const mgr3 = new LinkManager({ deviceId: id.deviceId, identity: id, registry: new Registry(otherHome, id.deviceId), homeDir: otherHome });
    assert.equal(mgr3.authorize({ token }).ok, false, '别的 home 不该认得这个令牌');
});
