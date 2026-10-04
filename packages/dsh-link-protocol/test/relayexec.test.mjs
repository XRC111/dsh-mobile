import assert from 'node:assert/strict';
import test from 'node:test';
import { startLinkServer, connectToHost } from '../lib/endpoint.js';
import { makeToken } from '../lib/protocol.js';
import { executeLocally } from '../lib/relayexec.js';
import { RELAY_METHOD, REMOTE_PROVIDER } from '../lib/llmrelay.js';

/** 造一个假的 llm runtime，按脚本吐 chunk。 */
function fakeCtx(chunks) {
    return { llm: { stream() { return (async function* () { for (const c of chunks) yield c; })(); } } };
}

test('转发执行：本地 adapter 的 chunk 按序回传', async () => {
  const token = makeToken();
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你' },
    { type: 'text-delta', index: 0, text: '好' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const server = await startLinkServer({ port: 0, token, device: {}, methods: [], onConnection(c) {
    c.handleStream(RELAY_METHOD, async (args, emit) => {
      assert.equal(args.provider, REMOTE_PROVIDER, '请求应带着约定的 provider');
      assert.equal(args.model, 'deepseek-chat', '模型名原样透传');
      return executeLocally(fakeCtx(chunks), emit, args, { signal: new AbortController().signal });
    });
  }});
  const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
  const got = [];
  const res = await client.callStream(RELAY_METHOD, { provider: REMOTE_PROVIDER, model: 'deepseek-chat' }, (c) => got.push(c));
  assert.deepEqual(got, chunks, '回传的 chunk 必须与本地产生的一致且有序');
  assert.equal(res.chunks, 6);
  await server.close();
});

test('转发执行：本地终态 error 要变成带 code 的抛错', async () => {
  const token = makeToken();
  const bad = [
    { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: '额度用尽' } } },
  ];
  const server = await startLinkServer({ port: 0, token, device: {}, methods: [], onConnection(c) {
    c.handleStream(RELAY_METHOD, async (args, emit) => executeLocally(fakeCtx(bad), emit, args, { signal: new AbortController().signal }));
  }});
  const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
  await assert.rejects(() => client.callStream(RELAY_METHOD, { provider: REMOTE_PROVIDER }, () => {}),
    (e) => { assert.equal(e.code, 'QUOTA_EXCEEDED'); assert.match(e.message, /额度/); return true; });
  await server.close();
});

test('转发执行：已中止时不再继续推流', async () => {
  const token = makeToken();
  const many = Array.from({ length: 5 }, (_, i) => ({ type: 'text-delta', index: 0, text: String(i) }));
  const ac = new AbortController();
  const server = await startLinkServer({ port: 0, token, device: {}, methods: [], onConnection(c) {
    c.handleStream(RELAY_METHOD, async (args, emit) => {
      ac.abort();  // 模拟调用中途被取消
      return executeLocally(fakeCtx(many), emit, args, { signal: ac.signal });
    });
  }});
  const client = await connectToHost({ host: '127.0.0.1', port: server.port, token, device: {}, methods: [] });
  const got = [];
  await client.callStream(RELAY_METHOD, { provider: REMOTE_PROVIDER }, (c) => got.push(c));
  assert.equal(got.length, 0, '已中止就不该再推任何 chunk');
  await server.close();
});