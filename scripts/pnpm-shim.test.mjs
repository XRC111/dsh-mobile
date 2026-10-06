/**
 * Android pnpm 替身（pnpm-lite + dshmarket 补丁）的回归测试。
 *
 * 跑法：node scripts/pnpm-shim.test.mjs
 *
 * ── 为什么这个测试必须存在 ──────────────────────────────────────────────────
 * 整套替身靠**字符串精确匹配**往第三方文件里插代码。锚点差一个空格就匹配不上，
 * 而匹配失败的表现不是报错 —— 是「安装静默失效」：补丁没打上，dsh-cli.js 照旧
 * spawn pnpm，在 Android 上必然 EACCES，但界面上完全看不出是补丁没打上。
 * 这类问题排查成本极高，所以在这里挡住。
 *
 * 检查三件事：
 *   1. launcher.cjs 语法合法；
 *   2. pnpm-lite.mjs 语法合法、且是 LF + 无 BOM（CRLF/BOM 会让锚点对不上）；
 *   3. 用 launcher 里的补丁定义能打到参考的 dshmarket 源码上，5 个挂载点全中，
 *      打完仍是合法 JS。
 *
 * ⚠️ 第 3 条的参考源码是**夹具**（scripts/fixtures/），不是每次都拿上游最新 ——
 *    上游更新是另一件事，由 dshmarket 的自更新在设备上完成。这里要保证的是
 *    「补丁逻辑本身没被改坏」。
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = join(ROOT, 'app/src/main/assets/nodejs-project/launcher.cjs');
const SHIM = join(ROOT, 'app/src/main/assets/bundle/pnpm-lite.mjs');
const FIXTURE = join(ROOT, 'scripts/fixtures/dsh-cli.dshmarket-1.66.8.js');

let pass = 0;
let fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass += 1; }
function bad(name, detail) { console.log(`  ✗ ${name}\n      ${detail}`); fail += 1; }

console.log('Android pnpm 替身回归测试\n');

// ── 1. 文件存在 ────────────────────────────────────────────────────────────
console.log('文件');
for (const [name, p] of [['launcher.cjs', LAUNCHER], ['pnpm-lite.mjs', SHIM], ['参考 dsh-cli.js', FIXTURE]]) {
    if (existsSync(p)) ok(`${name} 存在`);
    else bad(`${name} 缺失`, p);
}
if (fail > 0) {
    console.log(`\n${pass} 通过 / ${fail} 失败 —— 缺文件，后续检查跳过`);
    process.exit(1);
}

// ── 2. 语法 ────────────────────────────────────────────────────────────────
console.log('\n语法');
for (const [name, p] of [['launcher.cjs', LAUNCHER], ['pnpm-lite.mjs', SHIM], ['参考 dsh-cli.js', FIXTURE]]) {
    try {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
        ok(`${name} 语法合法`);
    } catch (e) {
        bad(`${name} 语法错误`, String(e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
    }
}

// ── 3. 编码：CRLF 与 BOM 都会让锚点对不上 ──────────────────────────────────
console.log('\n编码');
{
    const buf = readFileSync(SHIM);
    let crlf = 0;
    for (let i = 0; i < buf.length - 1; i += 1) if (buf[i] === 13 && buf[i + 1] === 10) crlf += 1;
    if (crlf === 0) ok('pnpm-lite.mjs 无 CRLF（锚点字符串是逐字节匹配的）');
    else bad('pnpm-lite.mjs 含 CRLF', `${crlf} 处 —— Windows 上编辑后没转换会导致补丁锚点全部失配`);

    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    if (!hasBom) ok('pnpm-lite.mjs 无 BOM');
    else bad('pnpm-lite.mjs 有 BOM', 'BOM 会让首行 import 语句对不上');
}

// ── 4. 补丁真的能打上，且打完仍合法 ────────────────────────────────────────
console.log('\n补丁应用（用 launcher 里的真实常量）');
process.env.DSH_LAUNCHER_EXPORT_ONLY = '1';
let mod;
try {
    mod = require(LAUNCHER);
    ok('launcher 导出补丁定义');
} catch (e) {
    bad('require launcher 失败', String(e.message));
}
if (mod) {
    const { DSMARKET_PATCHES, SHIM_APPLY_MARKER } = mod;
    if (Array.isArray(DSMARKET_PATCHES) && DSMARKET_PATCHES.length === 5) ok('5 个挂载点已定义');
    else bad('挂载点数量不对', `期望 5，实际 ${DSMARKET_PATCHES && DSMARKET_PATCHES.length}`);

    let text = readFileSync(FIXTURE, 'utf8');
    const missed = [];
    let applied = 0;
    for (const p of DSMARKET_PATCHES) {
        if (text.includes(p.marker)) { applied += 1; continue; }
        // 计数而非仅 contains：命中多处说明 find 太宽，会误伤别的函数。
        const hits = text.split(p.find).length - 1;
        if (hits === 1) { text = text.replace(p.find, p.replace); applied += 1; }
        else if (hits === 0) missed.push(p.find.split('\n')[0]);
        else missed.push(`${p.find.split('\n')[0]}（命中 ${hits} 次，find 太宽）`);
    }
    if (missed.length === 0) ok(`全部 ${DSMARKET_PATCHES.length} 个挂载点命中且唯一`);
    else bad('有挂载点没命中', missed.join(' / '));

    if (text.includes(SHIM_APPLY_MARKER)) ok('打补丁后能查到应用标记');
    else bad('打补丁后查不到应用标记', 'launcher 的 SHIM_APPLY_MARKER 与补丁产物不一致');

    const tmp = mkdtempSync(join(tmpdir(), 'shim-test-'));
    const out = join(tmp, 'patched.js');
    try {
        writeFileSync(out, text, 'utf8');
        execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
        ok('打完补丁仍是合法 JS');
    } catch (e) {
        bad('补丁破坏了 JS 语法', String(e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

console.log(`\n合计: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
