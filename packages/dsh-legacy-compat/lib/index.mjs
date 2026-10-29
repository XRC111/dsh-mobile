/**
 * 旧插件兼容层：判定「只适配旧版 dsh 的插件」在当前宿主上能不能跑。
 *
 * ── 它解决的具体问题 ────────────────────────────────────────────────────────
 * dsh 0.2 之后加了一道 gate（`evaluatePluginCompatibility`）：插件的
 * `engines.dsh` 或任一 `@deepseek-ai/dsh*` peer 不满足，就拒绝安装/加载，
 * 除非 profile 的 `compatibility.json` 里有**精确到版本**的豁免。
 *
 * 而生态里大量插件声明的是 `^0.1.5`、`^0.1.2-alpha.1`、`^0.0.9` 这类早已过去
 * 的线 —— 按 semver，`^0.1.5` 的上界是 `0.2.0-0`、`^0.0.9` 的上界是 `0.0.10-0`，
 * 于是在 0.2.x 上必然不满足。`>=0.0.1 <0.1.0`、`<=0.1.9`、`0.1.x` 这些不含
 * caret/tilde 的写法同理。dsh-market 也据此把它们标成「不兼容」，用户看到的
 * 是灰掉的安装按钮。
 *
 * 覆盖范围是**全部历史版本**：判据里没有任何一条写死的版本线，凡是「声明的
 * 下界不高于宿主」的老声明都走兼容判定。见 dsh-market 的 crossesLine。
 *
 * 但这些插件里有很多**实际能跑**：它们只用了 `ctx.effect`、`ctx.tools.register`
 * 这类从头到尾没变过的 API，真正变的只是作者写在 package.json 里的版本号。
 *
 * 所以本模块回答的不是「版本号满不满足」（那是 dsh 的 gate 干的），而是
 * 「这段代码在这台宿主上还能不能加载」—— 并给出可复核的依据。
 *
 * ── 四种结论 ───────────────────────────────────────────────────────────────
 *   native     版本要求本来就满足，不需要兼容层。
 *   bridged    版本不满足，但静态校验通过（它用的包都在、符号都在）。
 *   blocked    版本不满足且有确定的断裂：包没了，或符号没了。附带明细。
 *   unverified 版本不满足，但没有源码可校验（discovery 阶段只有 manifest）。
 *
 * 前两种和 unverified 都写豁免，只有 blocked 不写 —— 「查不到」不是「跑不了」。
 * 这个方向是刻意选的：不写豁免等于让 dsh 的 gate 直接拒绝加载，纯客户端插件
 * （主题、界面面板，生态里数量最多的一类）一个都装不上；写进去之后真出问题，
 * 坏的也只是它自己那块界面。详见 exemptionsFor 的注释。
 */

import { satisfies, isRange, compare } from './semver.mjs';
import { createSurface } from './surface.mjs';

export const VERDICT = Object.freeze({
    NATIVE: 'native',
    BRIDGED: 'bridged',
    BLOCKED: 'blocked',
    UNVERIFIED: 'unverified',
});

/** dsh 视为「指向当前运行时」的 workspace 协议写法。 */
const WORKSPACE_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*']);

/**
 * 插件声明的 dsh 要求里，宿主**不满足**的那些。
 *
 * ⚠️ 必须与 dsh 自己的 `unmetRequirements` 逐字同构，否则兼容层放行的插件
 *    会被 gate 再拒一次，用户看到「市场说能装、装完起不来」。
 *    对应实现见 @deepseek-ai/dsh-app-boot 的 plugin-compatibility 段：
 *      · 有顶层 `engines.dsh` → **只看它**，忽略所有 peer；
 *      · 否则看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer，
 *        且**任一**不满足即整体不满足；
 *      · `workspace:^` / `workspace:~` / `workspace:*` 视为当前运行时。
 *
 * @param {object} manifest 插件的 package.json（已解析）
 * @param {string} hostVersion 当前 dsh 版本
 * @returns {Record<string,string>} 键为 `engines.dsh` 或包名，值为声明的区间
 */
export function unmetRequirements(manifest, hostVersion) {
    const engines = manifest?.engines;
    if (engines !== null && typeof engines === 'object' && Object.hasOwn(engines, 'dsh')) {
        const range = engines.dsh;
        if (typeof range !== 'string') return { 'engines.dsh': '（不是字符串）' };
        return satisfies(hostVersion, range) ? {} : { 'engines.dsh': range };
    }
    const peers = manifest?.peerDependencies;
    if (peers === null || typeof peers !== 'object') return {};
    const unmet = {};
    for (const [name, range] of Object.entries(peers)) {
        if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
        if (typeof range !== 'string') { unmet[name] = '（不是字符串）'; continue; }
        if (WORKSPACE_RANGES.has(range)) continue;
        if (!satisfies(hostVersion, range)) unmet[name] = range;
    }
    return unmet;
}

/**
 * 把「包不可见」翻译成人能看懂的原因。
 *
 * 差分数据里记了这个包是在哪一段被移除的，以及**人工确认过**的替代关系
 * （data/renames.json）。注意区分两种「没有替代」：
 *   · `repairedBy === null` 且 `note` 有值 → 确认过，确实没有替代包；
 *   · 整个字段缺失 → 还没人确认过，只能说「找不到了」。
 * 混为一谈会让用户以为「官方说没有替代」，那是我们没查，不是查过了没有。
 */
function packageGap(pkg, probe, transitions) {
    const known = transitions?.removedPackages?.find((x) => x.package === pkg);
    const gap = {
        kind: 'package',
        package: pkg,
        reason: probe.renamedTo !== undefined ? 'renamed' : 'missing',
        detail: probe.renamedTo !== undefined
            ? `宿主里没有这个包，但存在改名后的 ${probe.renamedTo} —— 插件需要改 import。`
            : '宿主里解析不到这个包。',
    };
    if (known !== undefined) {
        gap.removedAt = known.removedAt;
        if (typeof known.repairedBy === 'string') {
            gap.repairedBy = known.repairedBy;
            gap.detail = `宿主里没有这个包；它已被 ${known.repairedBy} 取代，插件需要改 import。`;
        } else if (known.note !== null && known.note !== undefined) {
            // 人工确认过没有替代：把原因带上，别让用户以为还能换。
            gap.noReplacement = true;
            gap.detail = `宿主里没有这个包，且没有替代：${known.note}`;
        }
    }
    return gap;
}

/**
 * 判定一个插件。
 *
 * @param {object} input
 * @param {object} input.manifest   插件 package.json（已解析）
 * @param {string} input.hostVersion 当前 dsh 版本，如 `0.2.1-rc.4`
 * @param {{imports:Array,clientInjects:string[]}} [input.scanned] scanPluginDir 的结果；
 *   不传则只能给出 unverified（discovery 阶段的正常情况）
 * @param {object} [input.surface] createSurface 的返回值；不传则不做静态校验
 * @param {object} [input.transitions] data/transitions.json 的内容，仅用于补全「为什么没了」
 * @returns {{verdict:string, requirements:Record<string,string>, gaps:Array,
 *            checked:number, unchecked:Array, note:string}}
 */
export function evaluate({ manifest, hostVersion, scanned = null, surface = null, transitions = null }) {
    const requirements = unmetRequirements(manifest, hostVersion);

    if (Object.keys(requirements).length === 0) {
        return {
            verdict: VERDICT.NATIVE,
            requirements,
            gaps: [],
            checked: 0,
            unchecked: [],
            note: '版本要求本来就满足，不需要兼容层。',
        };
    }

    if (scanned === null || surface === null) {
        return {
            verdict: VERDICT.UNVERIFIED,
            requirements,
            gaps: [],
            checked: 0,
            unchecked: [],
            note: '版本要求不满足，但还没有插件源码可校验（市场列表阶段）。' +
                  '安装时会逐个 import 核对包与符号。',
        };
    }

    const gaps = [];
    const unchecked = [];
    let checked = 0;

    // 只校验宿主侧：客户端代码的 require 由浏览器侧模块表解析，Node 查不到，
    // 用它判可见性会把正常的主题/界面插件全部误判成「缺包」。
    for (const item of scanned.hostImports ?? []) {
        const probe = surface.probe(item.package);
        if (!probe.visible) {
            gaps.push({ ...packageGap(item.package, probe, transitions), usedBy: item.files });
            continue;
        }
        checked += 1;
        // symbols === null 有两种可能：命名空间导入（无法逐符号判），
        // 或入口文件读不出可信的符号表（压缩产物 / export *）。两种都不判。
        if (item.symbols === null || probe.symbols === null) {
            unchecked.push({ package: item.package, reason: item.symbols === null ? 'namespace' : 'unreadable' });
            continue;
        }
        const missing = item.symbols.filter((s) => !probe.symbols.has(s));
        if (missing.length > 0) {
            gaps.push({
                kind: 'symbol',
                package: item.package,
                symbols: missing,
                usedBy: item.files,
                detail: `这些名字在 ${item.package} 的导出里已经没了。`,
            });
        }
    }

    // 客户端侧一律记「未校验」—— 不是通过，也不是失败。
    for (const item of scanned.clientImports ?? []) {
        unchecked.push({ package: item.package, reason: 'client-side' });
    }
    if ((scanned.clientInjects ?? []).length > 0) {
        unchecked.push({ package: null, reason: 'client-inject', count: scanned.clientInjects.length });
    }

    if (gaps.length > 0) {
        return {
            verdict: VERDICT.BLOCKED,
            requirements,
            gaps,
            checked,
            unchecked,
            note: '版本要求不满足，且静态校验发现确定的断裂。',
        };
    }

    // 一个宿主侧的包都没引用，但确实有客户端依赖 —— 这类插件（主题、界面面板）
    // 的全部逻辑都在浏览器侧，而客户端模块表是**运行时按已装包的 dsh.client
    // 动态组成的**（见 dsh-client-modules 的 ClientModuleRegistry），不启动浏览器
    // 就无法确定某个模块名还在不在。
    //
    // 实测过：dsh-dracula-theme@1.1.0 的 dsh.client.inject 里有 dsh-client-store，
    // 而 0.2.1 的 79 个声明 dsh.client 的包里没有它。它到底是被合并进宿主了、
    // 还是真的没了，静态查不出来。所以只能说「未校验」，不能说「通过」。
    if (checked === 0 && unchecked.length > 0) {
        return {
            verdict: VERDICT.UNVERIFIED,
            requirements,
            gaps: [],
            checked,
            unchecked,
            note: '插件的逻辑全在客户端（浏览器侧），这部分接口无法静态校验 —— ' +
                  '客户端模块表要到运行时才组成。宿主侧没有可断裂的引用。',
        };
    }

    return {
        verdict: VERDICT.BRIDGED,
        requirements,
        gaps: [],
        checked,
        unchecked,
        note: `版本要求不满足，但用到的 ${checked} 个宿主包与全部具名符号都还在。`,
    };
}

/**
 * 生成给人看的一句话结论。
 * @param {ReturnType<typeof evaluate>} result
 */
export function explain(result) {
    switch (result.verdict) {
        case VERDICT.NATIVE:
            return '版本匹配。';
        case VERDICT.BRIDGED:
            return `经兼容层运行：${result.note}`;
        case VERDICT.UNVERIFIED:
            return '版本不匹配，安装时校验。';
        case VERDICT.BLOCKED: {
            const parts = result.gaps.map((gap) => {
                if (gap.kind === 'package') {
                    // 把 detail 一起带上：只说「缺包」等于让用户自己去猜，
                    // 而 detail 里是我们已经查清楚的结论（被谁取代 / 确认没有替代）。
                    const head = gap.repairedBy
                        ? `缺包 ${gap.package}（已由 ${gap.repairedBy} 取代）`
                        : `缺包 ${gap.package}${gap.noReplacement ? '（无替代）' : ''}`;
                    return `${head} —— ${gap.detail}`;
                }
                return `${gap.package} 缺符号 ${gap.symbols.join('、')}`;
            });
            return `不能运行：${parts.join('；')}`;
        }
        default:
            return '未知结论。';
    }
}

/**
 * 为一批插件算出「该写进 compatibility.json 的豁免」。
 *
 * @param {Array<{manifest:object, result:ReturnType<typeof evaluate>}>} entries
 * @param {string} hostVersion
 * @param {object} [options]
 * @param {boolean} [options.includeUnverified=false] 是否把「未校验」也算进来。
 *   默认仍是 false —— 这是 API 层面的保守默认，让调用方必须显式选择。
 *   移动端生成器（scripts/gen-mobile-compat.mjs）显式传了 true：那边是
 *   「插件随 APK 固定、用户没有第二次选择」，不写豁免等于让它永远不加载。
 *   理由见文件头的「四种结论」一段。
 * @returns {Record<string, string[]>} 形如 `{"pkg@1.2.3": ["0.2.1-rc.4"]}`
 */
export function exemptionsFor(entries, hostVersion, { includeUnverified = false } = {}) {
    const allow = new Set([VERDICT.BRIDGED]);
    if (includeUnverified) allow.add(VERDICT.UNVERIFIED);
    const out = {};
    for (const { manifest, result } of entries) {
        if (!allow.has(result.verdict)) continue;
        const name = manifest?.name;
        const version = manifest?.version;
        if (typeof name !== 'string' || typeof version !== 'string') continue;
        // dsh 的豁免要求**精确**的 name@version 与精确的运行时版本，
        // 写区间或写 latest 都不会生效（会被 readProfileCompatibility 丢掉）。
        const key = `${name}@${version}`;
        out[key] = out[key] ?? [];
        if (!out[key].includes(hostVersion)) out[key].push(hostVersion);
    }
    return out;
}

/** 便捷入口：给一个解析起点，直接建 surface。 */
export function surfaceFrom(resolveFrom, options = {}) {
    return createSurface({ resolveFrom, aliases: options.aliases });
}

export { satisfies, isRange, compare };
