/**
 * 桌面工具的 output schema 回归测试。
 *
 * 为什么需要它：曾经所有工具共用 `textOut({})`（空 properties +
 * additionalProperties:false），语义是"只接受空对象"。每个工具都返回带字段的
 * 对象，于是 dsh-tools 必然抛 INVALID_TOOL_OUTPUT ——
 * **副作用照常执行，返回值 100% 丢失**。表现是"服务起来了却拿不到配对码"，
 * 数据层完全正常，所以极难自查。
 *
 * 这个测试拿**真实的 dsh-tools 校验器**过一遍每个工具的代表性返回值，
 * 而且直接 import 插件导出的 schema 表（不复制实现，避免测的是副本）。
 *
 * 跑法：node scripts/link-schema.test.mjs（需要 runtime 形态的 node_modules）
 */

import assert from 'node:assert/strict';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { OUTPUT_SCHEMAS, PASSTHROUGH, passthroughOut } from '@dsh-desktop/link';
import test from 'node:test';

const textOut = (props) => ({
    schema: { type: 'object', additionalProperties: false, properties: props },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

/** 每个工具的代表性返回值 —— 覆盖 null 可空、嵌套对象、数组。 */
const CASES = [
    ['link_host_start', {
        running: true, port: 45731, code: '327872', codeExpiresInSeconds: 300,
        addresses: [{ address: '192.168.1.10', label: '局域网', iface: '以太网' }],
        primary: '192.168.1.10', hint: '在手机上执行 link_connect…',
    }],
    ['link_host_status', {
        running: false, port: null, code: null, codeExpiresInSeconds: 0,
        addresses: [], connected: null,
    }],
    ['link_host_status', {
        running: true, port: 45731, code: 'a', codeExpiresInSeconds: 1,
        addresses: [], connected: { device: { name: 'phone' }, encrypted: true },
    }],
    ['link_host_code', { code: '1', codeExpiresInSeconds: 300 }],
    ['link_host_stop', { running: false }],
    ['phone_status', { ok: true, width: 1080, height: 2400, density: 3, sdk: 34 }],
    ['phone_screen_elements', { ok: true, package: 'x', count: 1, truncated: false, elements: [{ name: 'b', cx: 1, cy: 2 }] }],
    ['phone_screen_shot', { path: 'C:/tmp/phone.png', width: 10, height: 20, bytes: 99 }],
    ['link_share_model', { files: ['llm-deepseek/files-v3.json'], credentials: null, note: 'x' }],
];

for (const [name, value] of CASES) {
    test('output schema 接受 ' + name + ' 的真实返回', async () => {
        const out = PASSTHROUGH.has(name) ? passthroughOut : textOut(OUTPUT_SCHEMAS[name] ?? {});
        const tool = defineTool({
            name, description: 'x', parameters: {}, output: out,
            async execute() { return value; },
            presentCall: () => ({ card: 'generic', title: name, kind: 'read', rawInput: {} }),
        });
        // 不抛 = 返回值没被 schema 拒收。
        const got = await tool.execute({});
        assert.deepEqual(got, value, '返回值应原样送达调用方');
    });
}

test('每个工具都声明了 schema（没有漏网的空对象）', () => {
    for (const [name] of CASES) {
        if (PASSTHROUGH.has(name)) continue;
        const props = OUTPUT_SCHEMAS[name];
        assert.ok(props && Object.keys(props).length > 0, name + ' 的 output schema 是空的 —— 会拒绝一切返回值');
    }
});
