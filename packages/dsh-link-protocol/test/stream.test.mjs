import { startLinkServer, connectToHost } from '../lib/endpoint.js';
import { makeToken } from '../lib/protocol.js';
import assert from 'node:assert/strict';
import test from 'node:test';

test('流式调用：事件按序到达，结果在 end 里带回来', async () => {
  const token = makeToken();
  const server = await startLinkServer({ port: 0, token, device: {}, methods: [], onConnection(c) {
    c.handleStream('llm.relay', async (args, emit) => {
      for (const tok of args.prompt.split(' ')) { emit({ type: 'delta', text: tok }); }
      return { usage: { total: args.prompt.length } };
    });
  }});
  const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
  const got = [];
  const result = await client.callStream('llm.relay', { prompt: 'hello world test' }, (d) => got.push(d.text));
  assert.deepEqual(got, ['hello', 'world', 'test']);
  assert.deepEqual(result, { usage: { total: 16 } });
  await server.close();
});

test('流式调用：处理器抛错要能穿过链路且带 code', async () => {
  const token = makeToken();
  const server = await startLinkServer({ port: 0, token, device: {}, methods: [], onConnection(c) {
    c.handleStream('llm.relay', async () => { const e = new Error('额度不足'); e.code = 'QUOTA'; throw e; });
  }});
  const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
  await assert.rejects(() => client.callStream('llm.relay', {}, () => {}),
    (e) => { assert.equal(e.code, 'QUOTA'); assert.match(e.message, /额度/); return true; });
  await server.close();
});

test('流式调用：未提供的方法返回 METHOD_NOT_FOUND', async () => {
  const token = makeToken();
  const server = await startLinkServer({ port: 0, token, device: {}, methods: [], onConnection() {} });
  const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
  await assert.rejects(() => client.callStream('nope', {}, () => {}), (e) => e.code === 'METHOD_NOT_FOUND');
  await server.close();
});

test('流式调用：断线时在途流被拒绝，不会悬挂', async () => {
  const token = makeToken();
  let connRef = null;
  const server = await startLinkServer({ port: 0, token, device: {}, methods: [], onConnection(c) {
    connRef = c;
    c.handleStream('llm.relay', () => new Promise(() => {}));  // 永不结束
  }});
  const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
  const inflight = client.callStream('llm.relay', {}, () => {});
  client.destroy();
  await assert.rejects(() => inflight, /连接关闭/);
  await server.close();
});