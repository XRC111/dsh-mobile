/**
 * 线路协议 / 连接层 / 握手 —— 回环测试。
 *
 * 全部在 127.0.0.1 上跑真 socket，不 mock：分帧、半包、双向调用、超时、令牌校验
 * 这些正是最容易写错的地方，用假对象测出来的通过没有意义。
 *
 * 跑法：node packages/dsh-link-protocol/test/link.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { LineDecoder, encode, fileChunks, joinChunks, makePairingCode, makeToken, PROTOCOL_VERSION } from '../lib/protocol.js';
import { startLinkServer, connectToHost } from '../lib/endpoint.js';
import { seal, open, splitSecrets, mergeSecrets, makeEphemeralKeyPair, deriveSessionKey } from '../lib/secret.js';

test('分帧：半包、粘包、空行都要正确', () => {
    const got = [];
    const d = new LineDecoder((m) => got.push(m));
    const a = encode({ t: 'one', v: 1 });
    const b = encode({ t: 'two', v: 2 });
    // 一次只喂半个字符都不该丢
    d.push(a.slice(0, 3));
    assert.equal(got.length, 0, '半包不能提前产出');
    d.push(a.slice(3) + b + '\n' + '   \n');
    assert.deepEqual(got, [{ t: 'one', v: 1 }, { t: 'two', v: 2 }]);
});

test('配对码是 6 位数字，令牌不重复', () => {
    for (let i = 0; i < 50; i += 1) assert.match(makePairingCode(), /^\d{6}$/);
    const tokens = new Set(Array.from({ length: 50 }, () => makeToken()));
    assert.equal(tokens.size, 50, '令牌不该重复');
});

test('文件分块往返', () => {
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const chunks = fileChunks(data, 128);
    assert.ok(chunks.length > 1, '应该切成多块');
    assert.deepEqual(joinChunks(chunks), data);
});

test('握手成功后双向都能调用对端', async () => {
    const token = makeToken();
    let hostSide = null;
    const server = await startLinkServer({
        port: 0,
        host: '127.0.0.1',
        token,
        device: { name: 'dev-desktop', platform: 'win32' },
        methods: ['computer.status'],
        onConnection: (conn) => { hostSide = conn; },
    });
    // 手机侧：注册一个 mobile.* 方法供桌面调用
    const client = await connectToHost({
        host: '127.0.0.1', port: server.port, token,
        device: { name: 'dev-phone', platform: 'android-arm64' },
        methods: ['mobile.status'],
    });
    client.handle('mobile.status', () => ({ battery: 88 }));

    // 桌面调手机
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(hostSide, '服务端应拿到连接');
    assert.deepEqual(await hostSide.call('mobile.status'), { battery: 88 });
    assert.equal(hostSide.peer.name, 'dev-phone');

    // 手机调桌面
    hostSide.handle('computer.status', () => ({ screens: 2 }));
    assert.deepEqual(await client.call('computer.status'), { screens: 2 });
    assert.equal(client.peer.name, 'dev-desktop');
    assert.deepEqual(client.peerMethods, ['computer.status']);

    await server.close();
});

test('令牌不对必须被拒', async () => {
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1', token: 'right-token',
        device: { name: 'd', platform: 'win32' }, methods: [],
        onConnection: () => { throw new Error('不该连上'); },
    });
    await assert.rejects(
        () => connectToHost({ host: '127.0.0.1', port: server.port, token: 'wrong-token', device: {}, methods: [] }),
        /配对被拒绝/,
    );
    await server.close();
});

test('协议版本不符必须被拒', async () => {
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1', token: 't',
        device: { name: 'd', platform: 'win32' }, methods: [],
        onConnection: () => {},
    });
    // 手工发一个版本不对的 hello
    const err = await new Promise((resolve) => {
        const s = net.connect(server.port, '127.0.0.1');
        s.on('connect', () => s.write(encode({ t: 'hello', proto: 999, token: 't', device: {}, methods: [] })));
        s.on('data', (buf) => { resolve(JSON.parse(buf.toString().split('\n')[0]).reason); s.destroy(); });
        s.on('error', () => resolve('socket error'));
    });
    assert.match(String(err), /protocol mismatch/);
    await server.close();
});

test('对端抛错要能穿过链路，且带 code', async () => {
    const token = makeToken();
    let hostSide = null;
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1', token, device: {}, methods: [], onConnection: (c) => { hostSide = c; },
    });
    const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
    client.handle('mobile.type', () => {
        const e = new Error('没有无障碍权限');
        e.code = 'NO_ACCESSIBILITY';
        throw e;
    });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
        () => hostSide.call('mobile.type', { text: 'hi' }),
        (error) => { assert.equal(error.code, 'NO_ACCESSIBILITY'); assert.match(error.message, /无障碍/); return true; },
    );
    await server.close();
});

test('未提供的方法返回 METHOD_NOT_FOUND', async () => {
    const token = makeToken();
    let hostSide = null;
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1', token, device: {}, methods: [], onConnection: (c) => { hostSide = c; },
    });
    const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(() => client.call('nope'), (e) => { assert.equal(e.code, 'METHOD_NOT_FOUND'); return true; });
    await server.close();
});

test('调用超时会拒绝', async () => {
    const token = makeToken();
    let hostSide = null;
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1', token, device: {}, methods: [], onConnection: (c) => { hostSide = c; },
    });
    const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
    client.handle('mobile.status', () => new Promise(() => {}));  // 永不兑现
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(() => hostSide.call('mobile.status', {}, { timeoutMs: 60 }), /超时/);
    await server.close();
});

test('对端断开时在途调用会被拒绝，close 会触发', async () => {
    const token = makeToken();
    let hostSide = null;
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1', token, device: {}, methods: [], onConnection: (c) => { hostSide = c; },
    });
    const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
    client.handle('mobile.status', () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 20));
    const closed = new Promise((r) => hostSide.on('close', r));
    const inflight = hostSide.call('mobile.status');
    client.destroy();
    await assert.rejects(() => inflight, /连接关闭/);
    await closed;
    await server.close();
});

test('事件能单向送达', async () => {
    const token = makeToken();
    let hostSide = null;
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1', token, device: {}, methods: [], onConnection: (c) => { hostSide = c; },
    });
    const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
    await new Promise((r) => setTimeout(r, 20));
    const got = new Promise((r) => client.on('event', (name, data) => r({ name, data })));
    hostSide.sendEvent('phone.battery', { percent: 42 });
    assert.deepEqual(await got, { name: 'phone.battery', data: { percent: 42 } });
    await server.close();
});

test('配对码换令牌：首次用码，之后用令牌', async () => {
    let issued = null;
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1',
        authorize: (hello) => {
            if (hello.code === '123456') {
                issued = makeToken();
                return { ok: true, token: issued };
            }
            if (hello.token && hello.token === issued) return { ok: true };
            return { ok: false, reason: 'bad code' };
        },
        device: { name: 'desktop', platform: 'win32' }, methods: [],
        onConnection: () => {},
    });
    // 首次：用配对码，服务端应发放令牌
    const first = await connectToHost({ host: '127.0.0.1', port: server.port, code: '123456', device: {}, methods: [] });
    assert.ok(first.issuedToken, '首次配对应拿到令牌');
    assert.equal(first.issuedToken, issued);

    // 之后：用令牌重连，不再需要码
    const second = await connectToHost({ host: '127.0.0.1', port: server.port, token: issued, device: {}, methods: [] });
    assert.ok(second, '拿令牌应能重连');

    // 错码必须被拒
    await assert.rejects(
        () => connectToHost({ host: '127.0.0.1', port: server.port, code: '000000', device: {}, methods: [] }),
        /配对被拒绝/,
    );
    await server.close();
});

test('两端派生出相同的会话密钥（ECDH + HKDF）', async () => {
    const a = makeEphemeralKeyPair();
    const b = makeEphemeralKeyPair();
    const ka = deriveSessionKey(a.privateKey, b.publicKey);
    const kb = deriveSessionKey(b.privateKey, a.publicKey);
    assert.deepEqual(ka, kb, '两端必须派生出同一个密钥');
    assert.equal(ka.length, 32);
    // 不同的一对不能撞出同样的密钥
    const c = makeEphemeralKeyPair();
    assert.notDeepEqual(ka, deriveSessionKey(c.privateKey, b.publicKey));
});

test('握手后连接上带有可用会话密钥', async () => {
    const token = makeToken();
    let hostSide = null;
    const server = await startLinkServer({
        port: 0, host: '127.0.0.1', token, device: {}, methods: [], onConnection: (c) => { hostSide = c; },
    });
    const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
    assert.ok(client.sessionKey, '客户端应有会话密钥');
    assert.ok(hostSide.sessionKey, '服务端应有会话密钥');
    assert.deepEqual(client.sessionKey, hostSide.sessionKey, '两端会话密钥必须一致');
    // 桌面能解开手机封的东西，反之亦然
    assert.deepEqual(open(hostSide.sessionKey, seal(client.sessionKey, { k: 'sk-phone' })), { k: 'sk-phone' });
    assert.deepEqual(open(client.sessionKey, seal(hostSide.sessionKey, { k: 'sk-desktop' })), { k: 'sk-desktop' });
    await server.close();
});

test('密封载荷：密钥不对或被改动都要失败', () => {
    const key = Buffer.alloc(32, 7);
    const other = Buffer.alloc(32, 9);
    const box = seal(key, { apiKey: 'sk-secret', model: 'deepseek-chat' });
    assert.deepEqual(open(key, box), { apiKey: 'sk-secret', model: 'deepseek-chat' });
    assert.throws(() => open(other, box), '换密钥必须解不开');
    // 翻掉密文里的一个 bit
    const raw = Buffer.from(box, 'base64');
    raw[raw.length - 1] ^= 0x01;
    assert.throws(() => open(key, raw.toString('base64')), '被改动必须校验失败');
});

test('splitSecrets 只把声明的字段封装起来', () => {
    const key = Buffer.alloc(32, 3);
    const { public: pub, secret } = splitSecrets(key, {
        model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-abc',
    }, ['apiKey']);
    assert.equal(pub.model, 'deepseek-chat');
    assert.equal(pub.apiKey, undefined, '机密字段不能留在明文里');
    assert.deepEqual(open(key, secret), { apiKey: 'sk-abc' });
    assert.deepEqual(mergeSecrets(key, pub, secret), {
        model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-abc',
    });
});
