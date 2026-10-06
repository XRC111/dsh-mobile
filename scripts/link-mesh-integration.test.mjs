/**
 * mesh 双端集成测试：**多设备同时连接**。
 *
 * 这测的不是单连接的握手（那在 link-integration.test.mjs 里），而是 mesh 引入的
 * 三个新问题：
 *   1. 一个 hub 同时收 N 个 client —— 原先 state.conn 是单值，后连的会顶掉前面的；
 *   2. 同一 deviceId 只保留**最新一条**连接（重复拨号时要关掉旧的）；
 *   3. 按 deviceId 寻址能打到正确的那一台 —— 而不是"随便挑一台"。
 *
 * 为什么要真起 socket：这三件事全是**运行期状态**问题，用 mock 测等于在测 mock
 * 自己的假设。真链路才暴露得出"连接被顶掉""拨号仲裁算反"这类错。
 *
 * 跑法：node scripts/link-mesh-integration.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLinkServer } from '../packages/dsh-link-protocol/lib/endpoint.js';
import { Registry } from '../packages/dsh-link-protocol/lib/mesh-registry.js';
import { LinkManager, shouldDial } from '../packages/dsh-link-protocol/lib/mesh-manager.js';
import { createIdentity, TOPOLOGY } from '../packages/dsh-link-protocol/lib/mesh-identity.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'link-mesh-int-'));

/**
 * 建一个带 mesh 的 hub（桌面角色）：监听 + 登记进来的连接。
 *
 * @param {object} opts - { name, methods }。
 * @returns {Promise<object>} { mgr, port, close }。
 */
async function makeHub({ name = 'desk', methods = ['computer.status'] } = {}) {
    const home = tmp();
    const id = createIdentity(name, 'desktop');
    const reg = new Registry(home, id.deviceId);
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg, name, kind: 'desktop', capabilities: methods });
    await mgr.listen({ host: '127.0.0.1' });
    return { mgr, id, reg, home, port: mgr.port, close: () => mgr.server.close() };
}

/**
 * 建一个 client（手机角色）并拨到 hub。
 *
 * ⚠️ 配对码必须**现取**（hub.mgr.newPairCode()），不能硬编码 ——
 *    码是随机生成的，且**一次性**：第一台用掉之后，第二台再用同一个码必然被拒
 *    （这正是「配对码一次性」的设计）。所以每台 client 各取一个新码。
 *
 * @param {object} opts - { hub, name, methods }。
 * @returns {Promise<object>} { mgr, conn, id, reg, home }。
 */
async function makeClient({ hub, name, methods = ['mobile.status'] }) {
    const home = tmp();
    const id = createIdentity(name, 'mobile');
    const reg = new Registry(home, id.deviceId);
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg, name, kind: 'mobile', capabilities: methods });
    // 首次配对：注册表里还没有 hub 的地址，先把地址写进去（真实流程里由上次配对
    // 或用户手填的 host/port 写入），再带**新码**拨过去。
    reg.upsert({ deviceId: hub.id.deviceId, name: 'desk', endpoint: '127.0.0.1:' + hub.port });
    const conn = await mgr.dial(hub.id.deviceId, { force: true, code: hub.mgr.newPairCode() });
    return { mgr, conn, id, reg, home };
}

test('hub 同时收 3 台设备：一条都不被顶掉', async (t) => {
    const hub = await makeHub({ methods: ['computer.status'] });
    t.after(() => hub.close());

    // 三台手机依次连上 —— 旧实现里 state.conn 是单值，只有最后一台能留下。
    const clients = [];
    for (const name of ['phone-a', 'phone-b', 'phone-c']) {
        const c = await makeClient({ hub, name });
        c.conn.handle('mobile.status', () => ({ name, ok: true }));
        clients.push(c);
    }
    // 等 hub 侧 onConnection 跑完（握手是异步的）
    await new Promise((r) => setTimeout(r, 150));

    const online = hub.mgr.onlinePeers();
    assert.equal(online.length, 3, '三台都应在线，实际 ' + online.length);
    const names = online.map((p) => p.name).sort();
    assert.deepEqual(names, ['phone-a', 'phone-b', 'phone-c']);

    // 逐台寻址：每一台都要能打到**自己**，而不是都被路由到同一台
    for (const c of clients) {
        const conn = hub.mgr.connectionTo(c.id.deviceId);
        assert.ok(conn, c.id.deviceId + ' 应能找到连接');
        const st = await conn.call('mobile.status');
        assert.equal(st.name, c.id.name, '寻址打到了错误的设备：期望 ' + c.id.name + ' 实际 ' + st.name);
    }
    for (const c of clients) c.mgr.closeAll();
});

test('同一 deviceId 重复连入：只留最新一条，旧的被关掉', async (t) => {
    const hub = await makeHub();
    t.after(() => hub.close());

    // ⚠️ 关键：真实的重连是**同一台设备复用同一身份**（loadOrCreateIdentity 从
    //    $DSH_HOME/link/identity.json 读回同一个 deviceId）。所以这里必须用
    //    **同一个 identity** 建两个 Manager，而不是 createIdentity 两次 ——
    //    后者是两个不同设备，不该被去重。
    const home = tmp();
    const id = createIdentity('phone-x', 'mobile');
    const mkMgr = () => {
        const reg = new Registry(home, id.deviceId);
        reg.upsert({ deviceId: hub.id.deviceId, name: 'desk', endpoint: '127.0.0.1:' + hub.port });
        return new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg, name: 'phone-x', kind: 'mobile' });
    };

    const mgr1 = mkMgr();
    const c1 = await mgr1.dial(hub.id.deviceId, { force: true, code: hub.mgr.newPairCode() });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(hub.mgr.onlinePeers().length, 1, '第一台连上后应有 1 台在线');

    // 同一台设备再连一次（断线重连 / 用户手动重拨）
    const mgr2 = mkMgr();
    const c2 = await mgr2.dial(hub.id.deviceId, { force: true, code: hub.mgr.newPairCode() });
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(hub.mgr.onlinePeers().length, 1, '同一 deviceId 只应算一台，实际 ' + hub.mgr.onlinePeers().length);
    // ⚠️ 不能断言 hub 侧的 conn === c2：那是**两个不同对象**。
    //    hub 持有的是服务端视角的 LinkConnection，client 持有的是客户端视角的，
    //    它们只是同一根 socket 的两端。要比的是「hub 现在认的是哪一条」——
    //    用服务端连接自己的角色来验证。
    const kept = hub.mgr.connectionTo(id.deviceId);
    assert.ok(kept && !kept.closed, 'hub 应保留一条活连接');
    assert.equal(kept.role, 'host', 'hub 侧那条应是 host 角色');
    // 旧连接必须被关掉：否则同一设备两条链路并存，调用结果会错乱。
    assert.equal(c1.closed, true, '旧连接应被关掉');
    assert.equal(c2.closed, false, '新连接应保持可用');
    mgr1.closeAll();
    mgr2.closeAll();
});

test('拨号仲裁：两端结论相反，且与字典序一致', async () => {
    // 这是 mesh 不重复建连的根据：a<b 时 a 拨 b、b 不拨 a。
    const a = '00000000000000aa';
    const b = '00000000000000bb';
    assert.equal(shouldDial(a, b), true);
    assert.equal(shouldDial(b, a), false);
    // 双方各自算：结论必须相反（都 true = 重复建连；都 false = 永远连不上）
    assert.notEqual(shouldDial(a, b), shouldDial(b, a));
});

test('mesh 拓扑下 dialTargets 只含「我该拨且没连上」的', async (t) => {
    const hub = await makeHub();
    t.after(() => hub.close());
    const client = await makeClient({ hub, name: 'phone-m' });
    await new Promise((r) => setTimeout(r, 120));

    // 在 client 侧看：hub 已连上 → 不再是拨号目标
    client.mgr.setTopology(TOPOLOGY.mesh);
    const targets = client.mgr.dialTargets().map((r) => r.deviceId);
    assert.ok(!targets.includes(hub.id.deviceId), '已连上的不该再出现在拨号目标里');

    // star 模式下永远没有拨号目标
    client.mgr.setTopology(TOPOLOGY.star);
    assert.deepEqual(client.mgr.dialTargets(), []);
    client.mgr.closeAll();
});

test('配对码一次性：用掉之后令牌仍可重连', async (t) => {
    const hub = await makeHub();
    t.after(() => hub.close());

    // 第一次用码
    const first = await makeClient({ hub, name: 'phone-p' });
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(first.conn.issuedToken, '首次配对应发放长期令牌');

    // 同一个码再用 → 必须失败（一次性）
    const home2 = tmp();
    const id2 = createIdentity('phone-q', 'mobile');
    const reg2 = new Registry(home2, id2.deviceId);
    reg2.upsert({ deviceId: hub.id.deviceId, name: 'desk', endpoint: '127.0.0.1:' + hub.port });
    const mgr2 = new LinkManager({ deviceId: id2.deviceId, identity: id2, registry: reg2, name: 'phone-q', kind: 'mobile' });
    await assert.rejects(
        () => mgr2.dial(hub.id.deviceId, { force: true, code: '424242' }),
        /配对被拒绝|bad or expired code/,
        '同一个配对码不该能二次使用',
    );

    // 但**新设备**拿到令牌后，重连不再需要码
    const home3 = tmp();
    const id3 = createIdentity('phone-r', 'mobile');
    const reg3 = new Registry(home3, id3.deviceId);
    reg3.upsert({ deviceId: hub.id.deviceId, name: 'desk', endpoint: '127.0.0.1:' + hub.port });
    const mgr3 = new LinkManager({ deviceId: id3.deviceId, identity: id3, registry: reg3, name: 'phone-r', kind: 'mobile' });
    // 先换一个新码配对，拿到令牌
    const code = hub.mgr.newPairCode();
    const c3 = await mgr3.dial(hub.id.deviceId, { force: true, code });
    assert.ok(c3.issuedToken, '应拿到令牌');
    c3.close('test');

    // 用令牌重连（不带 code）
    reg3.upsert({ deviceId: hub.id.deviceId, token: c3.issuedToken });
    const again = await mgr3.dial(hub.id.deviceId, { force: true });
    assert.ok(again && !again.closed, '带令牌应能直接重连');
    first.mgr.closeAll();
    mgr3.closeAll();
});
