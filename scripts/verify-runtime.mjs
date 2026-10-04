#!/usr/bin/env node
/**
 * 验证 extract-tar.cjs：把打包出的 tar.gz 解到临时目录，与阶段目录逐一比对。
 * 模拟手机首启的解压链路 —— 解压器坏了 App 就白屏，必须先在本机证明。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const req = createRequire(import.meta.url);
const { extractTarGz } = req(path.join(ROOT, 'app/src/main/assets/nodejs-project/extract-tar.cjs'));

const TAR = path.join(ROOT, 'app', 'src', 'main', 'assets', 'bundle', 'dsh-runtime.bin');
const OUT = path.join(ROOT, 'build', 'verify-out');
const STAGE = path.join(ROOT, 'build', 'runtime-stage');

function snapshot(dir) {
    const map = new Map();
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) {
                const rel = path.relative(dir, p).split(path.sep).join('/');
                map.set(rel, fs.statSync(p).size);
            }
        }
    };
    walk(dir);
    return map;
}

async function main() {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'runtime-manifest.json'), 'utf8'));
    console.log(`清单：${manifest.files} 文件，tar.gz ${manifest.tarGzBytes} 字节，sha256 ${manifest.sha256.slice(0, 16)}…`);

    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const t0 = Date.now();
    const st = await extractTarGz(TAR, OUT, (s) => {
        if (s.files % 4096 === 0 && s.files) process.stdout.write(`  已解压 ${s.files}\r`);
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n解压完成：files=${st.files} dirs=${st.dirs} bytes=${st.bytes}，耗时 ${secs}s`);

    const a = snapshot(STAGE);
    const b = snapshot(OUT);
    let missing = 0, sizeMismatch = 0, extra = 0;
    for (const [f, s] of a) {
        const got = b.get(f);
        if (got === undefined) { if (missing++ < 10) console.error('缺失:', f); }
        else if (got !== s) { if (sizeMismatch++ < 10) console.error('大小不符:', f, s, got); }
    }
    for (const f of b.keys()) if (!a.has(f)) { if (extra++ < 10) console.error('多出:', f); }

    console.log(`比对结果：期望 ${a.size}，实际 ${b.size}，缺失 ${missing}，大小不符 ${sizeMismatch}，多出 ${extra}`);
    if (missing || sizeMismatch || extra || st.files !== a.size) {
        console.error('FAIL');
        process.exit(1);
    }
    console.log('PASS：解压器与打包产物一致');
    // 大目录删除会被本机 node safe-delete shim 拦截（阈值 50），改走 cmd 原生
    try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* shim 拦截则留着 */ }
}

main().catch((e) => { console.error(e); process.exit(1); });
