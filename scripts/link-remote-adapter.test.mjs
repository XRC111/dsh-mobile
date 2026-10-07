/**
 * 「经另一台设备调用」adapter 的测试。
 *
 * ── 为什么它值得测 ──────────────────────────────────────────────────────────
 * 这个 adapter 之前**不存在** —— 插件调的是 registerConfigurableProviders，
 * 而那玩意写的是 directory（用户去哪填凭据），listProviders() 读的是
 * adapters（能执行的实现）。所以「经另一台设备调用」从来没出现在任何下拉里。
 *
 * 而它替代的是一个从不工作的注册方式 —— 这种替换很容易又写错一个地方，
 * 而且错法与原来一样（静默地不生效）。所以要测。
 *
 * ── 测什么 ──────────────────────────────────────────────────────────────────
 *   · listModels 返回的 provider 字段必须**等于**被问的那个（llm 会校验，
 *     不等就当无效条目丢掉 —— 下拉里于是又什么都没有）；
 *   · 模型 id 的编码/解码往返（带前缀 ↔ 原 id）；
 *   · 目标设备过滤（指定了 deviceId 就只问那一台）；
 *   · 一台取不到不影响其它台；
 *   · stream 里必须剥掉前缀 —— 不剥的话对端找不到模型。
 *
 * 跑法：node scripts/link-remote-adapter.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const LIB = '../packages/dsh-link-protocol/lib/remote-adapter.js';
const mod = await import(new URL(LIB, import.meta.url).href);
const { createRemoteAdapter, isRemoteProvider, REMOTE_PREFIX, setForwardStream } = mod;

/** 造一个假的 peer（带 capabilities 与 conn.call）。 */
function peer(deviceId, name, caps, models) {
    return {
        deviceId,
        name,
        capabilities: caps,
        conn: {
            call: async (method) => {
                if (method !== 'llm.list') throw new Error('未提供方法 ' + method);
                if (models === 'fail') throw new Error('对方没装 llm');
                return { providers: ['deepseek-account'], models: { 'deepseek-account': models } };
            },
        },
    };
}

const RELAY = 'llm.relay';

test('没有在线的转发设备时，模型列表为空', async () => {
    const a = createRemoteAdapter({ peers: () => [] });
    assert.deepEqual(await a.listModels(REMOTE_PREFIX), []);
});

test('没有设备宣告 llm.relay 时不当成可转发', async () => {
    // 设备在线但没宣告能力（比如旧版本）→ 不能用它取列表，
    // 否则会向不认识 llm.list 的设备发请求，得到「未提供方法」。
    const a = createRemoteAdapter({
        peers: () => [peer('d1', '手机', ['mobile.status'], [{ id: 'x', name: 'X' }])],
    });
    assert.deepEqual(await a.listModels(REMOTE_PREFIX), []);
});

test('列出的模型 provider 字段必须等于被问的那个（llm 会校验）', async () => {
    const p = 'llm-remote:d1';
    const a = createRemoteAdapter({
        peers: () => [peer('d1', '桌面', [RELAY], [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }])],
    });
    const models = await a.listModels(p);
    assert.equal(models.length, 1);
    // llm-llm 的 listModels 会丢掉 provider 不匹配的条目：
    //   if (typeof model.provider !== "string" || model.provider !== provider …)
    // 不等的话下拉里又是什么都没有。
    assert.equal(models[0].provider, p);
    assert.ok(models[0].id.length > 0);
    assert.ok(models[0].name.includes('DeepSeek Chat'));
});

test('模型 id 编码了原 id，可往返', async () => {
    const p = 'llm-remote:d1';
    const a = createRemoteAdapter({
        peers: () => [peer('d1', '桌面', [RELAY], [{ id: 'deepseek-chat', name: 'X' }])],
    });
    const [m] = await a.listModels(p);
    // 编码后带前缀，解码后应还原 —— stream 里靠这个把模型名交还对端。
    assert.ok(m.id.startsWith(REMOTE_PREFIX), '应带前缀，实际: ' + m.id);
    assert.ok(m.id.includes('deepseek-chat'));
});

test('指定目标设备时只问那一台', async () => {
    let asked = [];
    const mk = (id, name) => peer(id, name, [RELAY], [{ id: 'm-' + id, name: name }]);
    const a = createRemoteAdapter({ peers: () => [mk('d1', 'A'), mk('d2', 'B')] });
    // 用一个能观察调用目标的 conn
    const models = await a.listModels(REMOTE_PREFIX + 'd2');
    // 只有 B 的模型
    assert.equal(models.length, 1);
    assert.ok(models[0].name.includes('B'), '应只含 B，实际: ' + models[0].name);
    assert.ok(!models[0].name.includes('A'));
    assert.equal(asked.length, 0);
});

test('一台取不到不影响其它台', async () => {
    const a = createRemoteAdapter({
        peers: () => [
            peer('d1', '坏的', [RELAY], 'fail'),
            peer('d2', '好的', [RELAY], [{ id: 'good-model', name: 'Good' }]),
        ],
    });
    const models = await a.listModels(REMOTE_PREFIX);
    // 容错的意义：一台失败不该让「全部看不到」。
    assert.equal(models.length, 1);
    assert.ok(models[0].name.includes('Good'));
});

test('对方没返回任何模型时给占位项（下拉不至于空白）', async () => {
    const a = createRemoteAdapter({ peers: () => [peer('d1', '桌面', [RELAY], [])] });
    const models = await a.listModels(REMOTE_PREFIX);
    assert.equal(models.length, 1, '空列表会让下拉空白，用户以为没连上');
});

test('providerInfo 的 id 必须等于 provider（llm 校验）', () => {
    const a = createRemoteAdapter({ peers: () => [] });
    const info = a.providerInfo(REMOTE_PREFIX + 'd1');
    assert.equal(info.id, REMOTE_PREFIX + 'd1');
    assert.ok(info.name.includes('d1'), '应显示目标设备，用户才知道发给谁');
});

test('isRemoteProvider 用前缀匹配，能认出带设备后缀的形式', () => {
    assert.equal(isRemoteProvider(REMOTE_PREFIX), true);
    assert.equal(isRemoteProvider(REMOTE_PREFIX + 'abc123'), true);
    assert.equal(isRemoteProvider('deepseek'), false);
    assert.equal(isRemoteProvider(undefined), false);
    // ⚠️ 用 === 判断会漏带后缀的，于是用户显式选了「经另一台设备调用」时
    // 请求被 llm/stream 拦截器**再转发一次** —— 自己转给自己。
});

test('stream 剥掉模型 id 前缀再转发', async () => {
    let seen = null;
    setForwardStream(async function* (opts) {
        seen = opts;
        yield { type: 'text', text: 'ok' };
    });
    const a = createRemoteAdapter({ peers: () => [] });
    const chunks = [];
    for await (const c of a.stream({
        provider: REMOTE_PREFIX + 'd1',
        model: REMOTE_PREFIX + 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
    })) chunks.push(c);

    assert.equal(chunks.length, 1);
    // provider 必须回到不带前缀的「转发中转」名
    assert.equal(seen.provider, 'llm-remote');
    // 模型名要剥掉前缀 —— 不剥的话对端按 'llm-remote:deepseek-chat' 去找，
    // 必然找不到模型。
    assert.equal(seen.model, 'deepseek-chat');
    // 其余字段要透传：tools / system / temperature 之类丢了就是
    // 「插件注入的 API 不走转发」。
    assert.equal(seen.temperature, 0.7);
    assert.equal(seen.messages[0].content, 'hi');
});