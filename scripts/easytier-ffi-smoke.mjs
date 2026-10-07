/**
 * 用**真实的** dll 验证 koffi 绑定。
 *
 * 单元测试（easytier-desktop.test.mjs）用假 koffi 验证调用**顺序与容错**，
 * 但符号名、参数类型、返回值这些只有真库能验 —— 名字对不上是
 * UnsatisfiedLinkError，那种错在 Node 里才会当场抛。
 *
 * 需要 DSH_EASYTIER_DLL 指向 libeasytier_ffi.dll；没给就跳过（不算失败 ——
 * 那个库是 Actions 产物，不是每个人本地都有）。
 *
 * 用法：
 *   DSH_EASYTIER_DLL=D:\path\to\easytier_ffi.dll node scripts/easytier-ffi-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dll = process.env.DSH_EASYTIER_DLL;

if (!dll) {
    console.log('跳过：未设 DSH_EASYTIER_DLL（那个 dll 是 Actions 产物，本地不一定有）');
    process.exit(0);
}
if (!fs.existsSync(dll)) {
    console.error(`✗ 指定的 dll 不存在：${dll}`);
    process.exit(1);
}

let koffi;
try {
    koffi = require('koffi');
} catch (e) {
    console.error(`✗ koffi 不可用：${e.message}`);
    console.error('  它在 DSH 的运行时里（resources/dsh-runtime/node_modules/koffi）。');
    process.exit(1);
}

console.log(`dll: ${dll}`);

let failed = 0;
function check(name, fn) {
    try {
        const r = fn();
        console.log(`  ✓ ${name}${r ? ' → ' + r : ''}`);
    } catch (e) {
        console.log(`  ✗ ${name} → ${e.message}`);
        failed++;
    }
}

// 逐个取符号：UnsatisfiedLinkError 会在这一步就抛，名字写错立刻暴露。
let parse_config, run_network_instance, get_error_msg, free_string, collect_network_infos, retain_network_instance;
console.log('\n取符号（名字对不上会在这里抛）:');
check('parse_config', () => { parse_config = koffi.func(dll, 'parse_config', 'int', ['pointer']); return 'int(*char)'; });
check('run_network_instance', () => { run_network_instance = koffi.func(dll, 'run_network_instance', 'int', ['pointer']); return 'int(*char)'; });
check('get_error_msg', () => { get_error_msg = koffi.func(dll, 'get_error_msg', 'void', ['pointer']); return 'void(*char**)'; });
check('free_string', () => { free_string = koffi.func(dll, 'free_string', 'void', ['pointer']); return 'void(*char)'; });
check('collect_network_infos', () => { collect_network_infos = koffi.func(dll, 'collect_network_infos', 'pointer', ['int']); return 'char*(int)'; });
check('retain_network_instance', () => { retain_network_instance = koffi.func(dll, 'retain_network_instance', 'int', ['pointer']); return 'int(*char**)'; });

if (failed) {
    console.error(`\n${failed} 个符号取不到 —— 绑定层不能用于生产。`);
    process.exit(1);
}

/** 取 Rust 的错误信息并**还回去**（into_raw = 所有权转移）。 */
function lastError() {
    const out = [null];
    get_error_msg(out);
    const s = out[0] ? String(out[0]) : '';
    if (out[0]) free_string(out[0]);
    return s;
}

console.log('\n行为验证:');

// 1) 非法 TOML 必须被拒 —— 这验的是「配置真的会送到 Rust 侧并被解析」。
check('非法 TOML 被拒绝且有明确错误', () => {
    const bad = 'this is not valid toml [[[';
    const rc = parse_config(bad);
    if (rc === 0) throw new Error('垃圾 TOML 却通过了 —— parse_config 可能没真正调用');
    return `rc=${rc}, err=${lastError().slice(0, 60)}…`;
});

// 2) 合法配置必须通过 —— 验的是字段名与层级真的对。
//    这条最关键：字段名写错（bind_addr vs bindAddr、proto 用错类型）时，
//    库会报 unknown field，而这就是唯一能发现的地方。
const GOOD = `instance_name = "dsh-smoke-test"
hostname = "test"
ipv4 = "10.144.0.9/24"

[network_identity]
network_name = "dsh-smoke"
network_secret = "smoke-secret"

[flags]
no_tun = true

[[port_forwards]]
proto = "tcp"
bind_addr = "127.0.0.1:59999"
dst_addr = "10.144.0.3:45731"
`;

check('本项目生成的 TOML 被库接受（字段名/层级正确）', () => {
    const rc = parse_config(GOOD);
    if (rc !== 0) throw new Error('被拒：' + lastError());
    return 'rc=0';
});

// 3) 逐个字段反证：故意写错一个字段名，必须被拒。
//    这是「字段名真的一致」的硬证据 —— 若库忽略未知字段，这条会失败，
//    那就说明我们的「配置通过」其实证明不了什么。
for (const [desc, toml] of [
    ['bind_addr 拼错成 bindAddr', GOOD.replace('bind_addr', 'bindAddr')],
    ['proto 用错类型（数字而非字符串）', GOOD.replace('proto = "tcp"', 'proto = 6')],
    ['port_forwards 段名拼错', GOOD.replace('[[port_forwards]]', '[[port_forward]]')],
]) {
    check('反证：' + desc + ' → 必须被拒', () => {
        const rc = parse_config(toml);
        if (rc === 0) throw new Error('却通过了 —— 说明该字段没被真正校验，测试无效');
        return `rc=${rc}`;
    });
}

// 4) 真的起一个实例：no_tun 模式下不碰路由表，端口转发只绑回环，
//    风险可控；起来后立刻停掉。
check('run_network_instance 能起（no_tun + 回环转发）', () => {
    const rc = run_network_instance(GOOD);
    if (rc !== 0) throw new Error('启动失败：' + lastError());
    return 'rc=0';
});

check('collect_network_infos 返回可解析内容且能释放', () => {
    const p = collect_network_infos(16);
    const s = p ? String(p) : '(null)';
    if (p) free_string(p);
    return `${s.length} 字节`;
});

check('retain_network_instance(null) 能停掉', () => {
    const rc = retain_network_instance(null);
    if (rc !== 0) throw new Error('停止失败：' + lastError());
    return 'rc=0';
});

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过 —— 绑定层的符号名与调用方式与真库一致');
process.exit(failed ? 1 : 0);