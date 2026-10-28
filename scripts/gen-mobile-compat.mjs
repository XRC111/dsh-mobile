#!/usr/bin/env node
/**
 * 构建期生成移动端的兼容豁免（`app/src/main/assets/bundle/compatibility.json`）。
 *
 * ── 为什么在构建期做 ────────────────────────────────────────────────────────
 * 手机上的插件是**随 APK 固定**的，不存在「用户点了安装」这个时刻，也就没有
 * 一个自然的时机去调 dsh 的 `allow-version`。而这些插件是我们自己写的，
 * 构建期完全知道它们的 manifest 与源码 —— 那时判、那时写，最省事也最准。
 *
 * 运行期只做一件事：launcher 把这个文件合并进 `$DSH_HOME/profiles/web/`。
 *
 * ── 为什么只写精确 name@version ─────────────────────────────────────────────
 * dsh 的 `readProfileCompatibility` 只认精确键与精确版本；写区间会被判非法
 * 整条丢弃。插件版本变了就要重新判，这也是有意的 —— 一次豁免不等于永久豁免。
 *
 * 用法：
 *   node scripts/gen-mobile-compat.mjs --runtime build/runtime-stage \
 *     --out app/src/main/assets/bundle/compatibility.json
 *
 *   # 只校验某几个目录（替代默认的 plugins/ 与 assets/bundle/plugins/）
 *   node scripts/gen-mobile-compat.mjs --runtime <展开的运行时> \
 *     --plugin-dir /path/to/some-plugin --out /tmp/out.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate, exemptionsFor, unmetRequirements, VERDICT } from '../packages/dsh-legacy-compat/lib/index.mjs';
import { scanPluginDir } from '../packages/dsh-legacy-compat/lib/scan.mjs';
import { createSurface } from '../packages/dsh-legacy-compat/lib/surface.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 随包分发的插件所在目录（源 + 已就位的副本）。 */
const PLUGIN_DIRS = [
    path.join(ROOT, 'plugins'),
    path.join(ROOT, 'app/src/main/assets/bundle/plugins'),
];

function parseArgs(argv) {
    let runtime = path.join(ROOT, 'build/runtime-stage');
    let out = path.join(ROOT, 'app/src/main/assets/bundle/compatibility.json');
    // --plugin-dir 可重复；一旦给了就**完全替代**默认的两个目录，而不是追加。
    // 追加会让「只想校验某个插件」的人连着把随包插件也算一遍，输出里混进
    // 不相干的行，还多一次失败机会。
    const pluginDirs = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--runtime') runtime = path.resolve(argv[++i]);
        else if (argv[i] === '--out') out = path.resolve(argv[++i]);
        else if (argv[i] === '--plugin-dir') pluginDirs.push(path.resolve(argv[++i]));
    }
    return { runtime, out, pluginDirs: pluginDirs.length > 0 ? pluginDirs : PLUGIN_DIRS };
}

/** 列出 `@scope/name` 形式的插件目录（两层）。 */
function pluginDirsOf(base) {
    if (!fs.existsSync(base)) return [];
    // 直接指到一个插件根目录（它自己有 package.json）时就是它本身。
    // 不加这条的话，`--plugin-dir /path/to/one-plugin` 会去它**里面**找插件，
    // 找不到就输出「扫描 0 个插件」并以 0 退出 —— 一个查错的命令安静地
    // 报告「一切正常」，比报错更糟。
    if (fs.existsSync(path.join(base, 'package.json'))) return [base];
    const out = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = path.join(base, entry.name);
        if (entry.name.startsWith('@')) {
            for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
                if (inner.isDirectory()) out.push(path.join(full, inner.name));
            }
        } else {
            out.push(full);
        }
    }
    return out.filter((dir) => fs.existsSync(path.join(dir, 'package.json')));
}

function main() {
    const { runtime, out, pluginDirs } = parseArgs(process.argv.slice(2));
    const dshManifest = path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
    if (!fs.existsSync(dshManifest)) {
        console.error('找不到运行时：' + dshManifest);
        console.error('先跑 node scripts/pack-runtime.mjs，或用 --runtime 指定 npm install 的根目录。');
        process.exit(1);
    }
    const hostVersion = JSON.parse(fs.readFileSync(dshManifest, 'utf8')).version;
    const surface = createSurface({ resolveFrom: [dshManifest] });

    let transitions = null;
    try {
        transitions = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/dsh-legacy-compat/data/transitions.json'), 'utf8'));
    } catch { /* 没有差分数据也能判，只是少了解释文字 */ }

    const entries = [];
    const seen = new Set();
    for (const base of pluginDirs) {
        for (const dir of pluginDirsOf(base)) {
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            // 两个目录可能装的是同一个插件（源与副本），按 name@version 去重。
            const key = `${manifest.name}@${manifest.version}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const result = evaluate({
                manifest,
                hostVersion,
                scanned: scanPluginDir(dir),
                surface,
                transitions,
            });
            entries.push({ manifest, result, dir: path.relative(ROOT, dir) });
        }
    }

    const exemptions = exemptionsFor(entries, hostVersion);

    // 如实打印：判不了的必须让人看见，不能悄悄跳过。
    const byVerdict = {};
    for (const { result } of entries) byVerdict[result.verdict] = (byVerdict[result.verdict] ?? 0) + 1;
    console.log(`宿主 ${hostVersion}，扫描 ${entries.length} 个插件：` +
        Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join(' '));
    for (const { manifest, result, dir } of entries) {
        if (result.verdict === VERDICT.BLOCKED) {
            console.log(`  ✗ ${manifest.name}@${manifest.version}（${dir}）`);
            for (const gap of result.gaps) {
                console.log(`      ${gap.kind === 'package' ? `缺包 ${gap.package}` : `${gap.package} 缺符号 ${gap.symbols.join('、')}`}：${gap.detail}`);
            }
        }
    }
    // blocked 的插件写进 APK 也是白搭（dsh 会拒绝加载），构建期就报出来。
    const blocked = entries.filter((e) => e.result.verdict === VERDICT.BLOCKED);
    if (blocked.length > 0) {
        console.error(`\n有 ${blocked.length} 个内置插件在当前宿主上无法运行，先修它们再打包。`);
        process.exit(1);
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    const sorted = {};
    for (const key of Object.keys(exemptions).sort()) sorted[key] = exemptions[key];
    fs.writeFileSync(out, JSON.stringify(sorted, null, 2) + '\n');
    console.log('已写入 ' + path.relative(ROOT, out) + `（${Object.keys(sorted).length} 条精确豁免）`);
}

main();
