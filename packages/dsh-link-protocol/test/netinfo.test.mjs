/**
 * 地址分类器测试。
 *
 * 这个模块的输出会**直接显示给用户**，让他照着填地址 —— 标错比不标更糟
 * （用户会照着错的填，然后只得到"连不上"三个字）。所以每条规则都要有测试，
 * 而且**必须包含"不该误判"的反例**：'zt' 前缀、普通私网段不能被认成虚拟网卡。
 *
 * 跑法：node packages/dsh-link-protocol/test/netinfo.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAddress, describeAddresses } from '../lib/netinfo.js';

test('按网卡名识别组网工具（最可靠的依据）', () => {
    assert.equal(classifyAddress('Tailscale', '100.101.102.103', 'IPv4').kind, 'tailscale');
    assert.equal(classifyAddress('tailscale0', '100.64.0.1', 'IPv4').kind, 'tailscale');
    assert.equal(classifyAddress('easytier', '10.126.126.5', 'IPv4').kind, 'easytier');
    assert.equal(classifyAddress('ztabcdef1234', '10.147.17.5', 'IPv4').kind, 'zerotier');
    assert.equal(classifyAddress('wg0', '10.8.0.2', 'IPv4').kind, 'wireguard');
    assert.equal(classifyAddress('docker0', '172.17.0.1', 'IPv4').kind, 'docker');
    assert.equal(classifyAddress('vEthernet (WSL)', '172.20.0.1', 'IPv4').kind, 'wsl');
});

test('不误判：普通网卡名不该被认成虚拟网卡', () => {
    // 'zt' 规则要求后面跟 6+ 位十六进制，否则 'ezt' 之类会被误标。
    assert.notEqual(classifyAddress('ethernet0', '10.0.0.5', 'IPv4').kind, 'zerotier');
    assert.notEqual(classifyAddress('WLAN', '192.168.1.20', 'IPv4').kind, 'zerotier');
    // 普通网卡 + 私网地址 = 局域网，不是任何 overlay。
    assert.equal(classifyAddress('以太网', '192.168.1.20', 'IPv4').kind, 'lan');
    assert.equal(classifyAddress('Ethernet', '10.0.0.5', 'IPv4').kind, 'lan');
    assert.equal(classifyAddress('en0', '172.16.5.5', 'IPv4').kind, 'lan');
});

test('地址段辅助判断：网卡名给不出结论时按段认', () => {
    // 未知网卡名 + Tailscale 的 CGNAT 段（100.64.0.0/10）
    assert.equal(classifyAddress('tun9', '100.90.1.2', 'IPv4').kind, 'tailscale');
    // 边界：100.63/100.128 都在 CGNAT 段之外
    assert.notEqual(classifyAddress('tun9', '100.128.0.1', 'IPv4').kind, 'tailscale');
    // 按段推测的置信度是 medium，不是 high
    assert.equal(classifyAddress('tun9', '100.90.1.2', 'IPv4').confidence, 'medium');
    assert.equal(classifyAddress('Tailscale', '100.90.1.2', 'IPv4').confidence, 'high');
    // 未知网卡名 + EasyTier 默认网段
    assert.equal(classifyAddress('tun9', '10.126.126.9', 'IPv4').kind, 'easytier');
    // 100.x 之外的边界：100.63 不属于 100.64/10
    assert.notEqual(classifyAddress('tun9', '100.63.1.2', 'IPv4').kind, 'tailscale');
    // 172.17/16 之外的边界
    assert.notEqual(classifyAddress('tun9', '172.18.0.1', 'IPv4').kind, 'docker');
});

test('IPv6：公网、尾迹、ULA、链路本地分别认出来', () => {
    assert.equal(classifyAddress('以太网', '240e:398:b3c3:70b0::1', 'IPv6').kind, 'public-v6');
    assert.equal(classifyAddress('Tailscale', 'fd7a:115c:a1e0::1', 'IPv6').kind, 'tailscale');
    assert.equal(classifyAddress('eth0', 'fd12:3456::1', 'IPv6').kind, 'ula');
    assert.equal(classifyAddress('eth0', 'fe80::1', 'IPv6').kind, 'linklocal');
});

test('不可用地址被标出来，但仍会返回（便于解释"为什么没列"）', () => {
    const link = classifyAddress('eth0', '169.254.1.1', 'IPv4');
    assert.equal(link.kind, 'linklocal');
    assert.equal(link.usable, undefined); // usable 由 describeAddresses 决定
    const list = describeAddresses({
        eth0: [{ address: '169.254.1.1', family: 'IPv4', internal: false }],
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    assert.equal(list.length, 1, '回环应被过滤掉');
    assert.equal(list[0].usable, false);
});

test('排序：可用的在前，局域网优先于虚拟网卡', () => {
    const list = describeAddresses({
        docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
        '以太网': [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
        Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
        eth0: [{ address: '169.254.9.9', family: 'IPv4', internal: false }],
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    assert.equal(list.length, 4, '回环不列');
    assert.equal(list[0].address, '192.168.1.10', '局域网排第一');
    assert.equal(list[0].kind, 'lan');
    assert.equal(list[list.length - 1].usable, false, '链路本地排最后');
    // Docker 是**机器内部**网络，外部设备连不到 —— 必须排在真正的 overlay 之后。
    const kinds = list.map((x) => x.kind);
    assert.ok(kinds.indexOf('tailscale') < kinds.indexOf('docker'), 'Docker 应沉底（外部连不到）');
});

test('describeAddresses 输出带 iface 与 hint，供界面直接渲染', () => {
    const list = describeAddresses({
        Tailscale: [{ address: '100.64.0.5', family: 'IPv4', internal: false }],
    });
    assert.equal(list[0].iface, 'Tailscale');
    assert.equal(list[0].label, 'Tailscale');
    assert.match(list[0].hint, /虚拟网卡/);
});

test('空输入不炸', () => {
    assert.deepEqual(describeAddresses({}), []);
    assert.deepEqual(describeAddresses(null), []);
    assert.equal(classifyAddress('x', 'not-an-ip', 'IPv4').kind, 'public-v4');
});
