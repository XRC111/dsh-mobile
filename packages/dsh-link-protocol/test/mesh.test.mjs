/**
 * mesh 核心（identity / registry / manager）单元测试。
 *
 * 这些是纯逻辑，不需要网络：身份稳定性、注册表增删、拨号仲裁。
 * 「谁拨谁」的仲裁尤其要测 —— 它一旦两端算出相反结论，就会各建一条连接，
 * 表现为同���设备重复、工具调用结果莫名其妙。
 *
 * 跑法：node packages/dsh-link-protocol/test/mesh.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIdentity, loadOrCreateIdentity, TOPOLOGY } from '../lib/mesh-identity.js';
import { Registry, PeerRecord } from '../lib/mesh-registry.js';
import { LinkManager, shouldDial } from '../lib/mesh-manager.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'link-mesh-'));

test('身份稳定：同一台设备重复载入得到同一个 deviceId', () => {
    const home = tmp();
    const a = loadOrCreateIdentity(home, 'desk', 'desktop');
    const b = loadOrCreateIdentity(home, 'desk', 'desktop');
    assert.equal(a.deviceId, b.deviceId);
    assert.equal(a.deviceId.length, 16);
    // 私钥必须落盘（否则重启后无法做密钥协商）。
    assert.ok(fs.existsSync(path.join(home, 'link', 'identity.json')));
});

test('不同设备得到不同 deviceId', () => {
    const a = createIdentity('a');
    const b = createIdentity('b');
    assert.notEqual(a.deviceId, b.deviceId);
});

test('身份文件损坏时重新生成而不是抛错', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, 'link'), { recursive: true });
    fs.writeFileSync(path.join(home, 'link', 'identity.json'), '{ 这不是 json');
    const id = loadOrCreateIdentity(home, 'x');
    assert.ok(id.deviceId);
});

test('注册表：增删改查', () => {
    const home = tmp();
    const reg = new Registry(home, 'self0000000000');
    assert.equal(reg.size, 0);
    reg.upsert({ deviceId: 'p1', name: 'phone', kind: 'mobile', endpoint: '192.168.1.5:45731' });
    assert.equal(reg.size, 1);
    assert.equal(reg.get('p1').name, 'phone');
    // partial 更新不能把已有字段清空
    reg.upsert({ deviceId: 'p1', name: 'phone2' });
    assert.equal(reg.get('p1').name, 'phone2');
    assert.equal(reg.get('p1').endpoint, '192.168.1.5:45731');
    assert.ok(reg.remove('p1'));
    assert.equal(reg.size, 0);
    assert.equal(reg.remove('p1'), false);
});

test('注册表：不能登记自己', () => {
    const reg = new Registry(tmp(), 'self0000000000');
    assert.throws(() => reg.upsert({ deviceId: 'self0000000000' }), /不能把自己/);
});

test('注册表：重新载入后数据仍在，且跳过自己', () => {
    const home = tmp();
    const reg = new Registry(home, 'self0000000000');
    reg.upsert({ deviceId: 'p1', name: 'phone' });
    const reg2 = new Registry(home, 'self0000000000');
    assert.equal(reg2.size, 1);
    assert.equal(reg2.get('p1').name, 'phone');
});

test('拨号仲裁：两端必须得出相反且一致的结论', () => {
    // 这是 mesh 不重复建连的关键：a<b 则 a 拨 b；b 不拨 a。
    assert.equal(shouldDial('aaa', 'bbb'), true);
    assert.equal(shouldDial('bbb', 'aaa'), false);
    // 交换参数必须取反（不能两边都 true 或都 false）
    for (const [a, b] of [['a', 'b'], ['0011', '0022'], ['x', 'y']]) {
        assert.equal(shouldDial(a, b), !shouldDial(b, a), a + '/' + b + ' 的方向应相反');
    }
});

test('连接管理器：跟踪连接、同设备只留最新一条', () => {
    const home = tmp();
    const id = createIdentity('me');
    const reg = new Registry(home, id.deviceId);
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg, name: 'me' });
    const c1 = { closed: false, close() { this.closed = true; }, peer: { name: 'desk' }, sessionKey: null, peerMethods: ['computer.status'] };
    const c2 = { closed: false, close() { this.closed = true; }, peer: { name: 'desk' }, sessionKey: null, peerMethods: [] };
    mgr.track('in', 'peer1', c1);
    mgr.track('in', 'peer1', c2);
    assert.equal(c1.closed, true, '旧连接应被关掉');
    assert.equal(mgr.connectionTo('peer1'), c2);
    assert.ok(mgr.anyConnected);
    const peers = mgr.onlinePeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].direction, 'inbound');
    mgr.closeAll();
});

test('连接管理器：onlinePeers 合并两个方向且不重复', () => {
    const home = tmp();
    const id = createIdentity('me');
    const reg = new Registry(home, id.deviceId);
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg });
    const mk = (name) => ({ closed: false, close() { this.closed = true; }, peer: { name }, sessionKey: null, peerMethods: [] });
    mgr.track('in', 'a', mk('a'));
    mgr.track('out', 'b', mk('b'));
    mgr.track('out', 'a', mk('a-out'));
    const peers = mgr.onlinePeers();
    const ids = peers.map((p) => p.deviceId);
    assert.equal(new Set(ids).size, ids.length, '同一设备不应出现两次');
    assert.ok(ids.includes('a') && ids.includes('b'));
});

test('配对码：一次性、过期即废', () => {
    const home = tmp();
    const id = createIdentity('me');
    const reg = new Registry(home, id.deviceId);
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg });
    const code = mgr.newPairCode();
    assert.match(code, /^[0-9]{6}$/);
    // 第一次用码 → 通过并发放令牌
    const r1 = mgr.authorize({ code });
    assert.equal(r1.ok, true);
    assert.ok(r1.token);
    // 同一个码再用 → 必须失败
    const r2 = mgr.authorize({ code });
    assert.equal(r2.ok, false);
    // 令牌可以重连
    const r3 = mgr.authorize({ token: r1.token });
    assert.equal(r3.ok, true);
});

// ── 接线后新增：拓扑、拨号目标、令牌落盘 ────────────────────────────────────

test('拓扑切换：只认 star / mesh，非法值回落 star', () => {
    const id = createIdentity('me');
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: new Registry(tmp(), id.deviceId) });
    // 默认为 mesh（超集：同时监听与主动拨；没有 overlay 时退化到 star 的可用性）。
    assert.equal(mgr.topology, TOPOLOGY.mesh, '默认是 mesh');
    assert.equal(mgr.setTopology(TOPOLOGY.star), TOPOLOGY.star);
    assert.equal(mgr.setTopology(TOPOLOGY.mesh), TOPOLOGY.mesh);
    // 非法值必须**安全回落**，不能保持原值 —— 否则一个拼错的拓扑名会静默生效。
    assert.equal(mgr.setTopology('乱填'), TOPOLOGY.star);
});

test('拨号目标：star 下不主动拨任何人', () => {
    const home = tmp();
    const id = createIdentity('me');
    const reg = new Registry(home, id.deviceId);
    reg.upsert({ deviceId: 'zzz', endpoint: '10.0.0.9:45731' });
    const mgr = new LinkManager({ deviceId: id.deviceId, identity: id, registry: reg });
    // 默认是 mesh，所以这里**显式**切到 star 再断言 —— 测的是 star 的语义，
    // 不是默认值。
    mgr.setTopology(TOPOLOGY.star);
    assert.deepEqual(mgr.dialTargets(), [], 'star 模式不拨号');
});

test('拨号目标：mesh 下只拨「我该拨且没连上」的', () => {
    const home = tmp();
    // deviceId 用可控值，直接构造 Manager（不经过 createIdentity 的随机 id）
    const reg = new Registry(home, 'mmmmmmmmmmmmmmmm');
    reg.upsert({ deviceId: 'aaaa', endpoint: '10.0.0.1:45731' });  // 我更大 → 不拨
    reg.upsert({ deviceId: 'zzzz', endpoint: '10.0.0.2:45731' });  // 我更小 → 要拨
    reg.upsert({ deviceId: 'yyyy', endpoint: null });              // 没地址 → 跳过
    const mgr = new LinkManager({ deviceId: 'mmmmmmmmmmmmmmmm', identity: {}, registry: reg });
    mgr.setTopology(TOPOLOGY.mesh);
    const targets = mgr.dialTargets().map((r) => r.deviceId);
    assert.deepEqual(targets, ['zzzz'], '只拨字典序更大的且有地址的');

    // 已经连上的不再拨
    mgr.track('out', 'zzzz', { closed: false, close() {} });
    assert.deepEqual(mgr.dialTargets(), []);
});

test('令牌落盘：注册表能存能读，且不出现在 toPublic', () => {
    const home = tmp();
    const reg = new Registry(home, 'self0000000000');
    reg.upsert({ deviceId: 'p1', name: 'desk', token: 'secret-token-abc' });
    // 重新载入 → 令牌必须还在（否则每次重连都要重新输一次性配对码）
    const reg2 = new Registry(home, 'self0000000000');
    assert.equal(reg2.get('p1').token, 'secret-token-abc');
    // 但对外形态不能带令牌（它会进 HTTP 响应与 UI）
    assert.equal(reg2.get('p1').toPublic().token, undefined);
    assert.equal(reg2.get('p1').toPublic().paired, true);
});

test('令牌不会被 partial 更新抹掉', () => {
    const reg = new Registry(tmp(), 'self0000000000');
    reg.upsert({ deviceId: 'p1', token: 'tk' });
    reg.upsert({ deviceId: 'p1', lastSeen: 123 });
    assert.equal(reg.get('p1').token, 'tk', 'partial 更新不该清空令牌');
});
