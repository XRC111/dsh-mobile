/**
 * 精简版 semver：只做「版本是否落在区间内」这一件事。
 *
 * ── 为什么不用 npm 的 semver 包 ────────────────────────────────────────────
 * 这份代码要随插件分发到两个运行环境：
 *   · dsh-desktop 的 profile（dshmarket 内，安装期不能跑 npm install）；
 *   · dsh-mobile 的构建脚本。
 * 两处都拿不到 node_modules 里的 semver（dshmarket 自己的 check.js 是另写的
 * 一套，也不能引）。而这里需要的只是 satisfies，不到 200 行，比引入依赖划算。
 *
 * ── 语义必须与 dsh 的 gate 一致 ────────────────────────────────────────────
 * dsh 的 `unmetRequirements` 调的是 `semver.satisfies(host, range, {
 * includePrerelease: true })`。判定结果必须能与它逐字对齐 —— 否则会出现
 * 「兼容层说能跑、gate 说不能」或者反过来，这类不一致比不兼容本身更难查。
 *
 * 所以：**包含 prerelease 的比较一律按纯区间比较处理**（这正是
 * includePrerelease 的效果：不再排除 prerelease 版本），不在 `^` / `~`
 * 展开之外做任何额外放宽。
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * 解析一个精确版本。
 * @param {string} value
 * @returns {{major:number,minor:number,patch:number,pre:string[],raw:string}|null}
 */
export function parse(value) {
    if (typeof value !== 'string') return null;
    const m = VERSION_RE.exec(value.trim());
    if (m === null) return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        pre: m[4] === undefined ? [] : m[4].split('.'),
        raw: value.trim(),
    };
}

/** 是否为合法的精确版本（含 prerelease / build）。 */
export function isExact(value) {
    return parse(value) !== null;
}

function comparePre(a, b) {
    if (a.length === 0 && b.length === 0) return 0;
    // 有 prerelease 的版本**小于**同号的正式版。
    if (a.length === 0) return 1;
    if (b.length === 0) return -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i];
        const y = b[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) {
            const d = Number(x) - Number(y);
            if (d !== 0) return d > 0 ? 1 : -1;
            continue;
        }
        // 数字段小于非数字段（semver 规范 11.4.3）。
        if (xn !== yn) return xn ? -1 : 1;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

/**
 * 比较两个版本。
 * @returns {number} a>b → 1，a<b → -1，相等 0。无法解析时抛错 —— 静默按 0
 *   处理会让「解析失败」看起来像「版本相同」，那是最坏的失败模式。
 */
export function compare(a, b) {
    const pa = typeof a === 'string' ? parse(a) : a;
    const pb = typeof b === 'string' ? parse(b) : b;
    if (pa === null || pb === null) throw new Error(`无法比较版本：${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    for (const k of ['major', 'minor', 'patch']) {
        const d = pa[k] - pb[k];
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return comparePre(pa.pre, pb.pre);
}

/**
 * `^` 的上界：第一个非零位进一位。
 *
 *    ^1.2.3 → <2.0.0-0    ^0.2.3 → <0.3.0-0    ^0.0.3 → <0.0.4-0
 *
 * 注意 0.x 的特殊性：`^0.1.5` 的上界是 `0.2.0-0`，这正是「0.1.x 插件在
 * 0.2 宿主上被判不兼容」的算术来源。
 */
function caretUpper(v) {
    if (v.major > 0) return `${v.major + 1}.0.0-0`;
    if (v.minor > 0) return `0.${v.minor + 1}.0-0`;
    return `0.0.${v.patch + 1}-0`;
}

/** `~` 的上界：锁 minor，patch 放开。~1.2.3 → <1.3.0-0；~0.2.3 → <0.3.0-0 */
function tildeUpper(v) {
    return `${v.major}.${v.minor + 1}.0-0`;
}

/**
 * 把比较器展开成 [下界, 上界] 两个边界（含或不含）。
 * 返回 null 表示无法解析 —— 调用方应把该区间视为「不可判定」，
 * **不要**当成满足。
 *
 * 支持的写法（都在真实插件里出现过，见 test/semver.test.mjs）：
 *   `^1.2.3` `~0.1.5` `>=0.1.5` `>= 0.1.5`（操作符后有空格）`1.2.3`
 *   `0.2.x` `1.x` `*` / `x` / `X`（通配）
 */
function expandComparator(text) {
    // 操作符与版本之间允许有空格 —— node-semver 接受 `>= 0.1.5`，
    // 而按空格 split 会把它切成两段，必须先把这段空格吃掉。
    const normalized = text.trim().replace(/^(\^|~|>=|<=|>|<|=)\s+/, '$1');

    // 通配：`*` / `x` / `X` 单独出现时匹配任意版本。
    if (/^[*xX]$/.test(normalized)) return { lower: null, upper: null };

    // 数字段通配：`0.2.x`、`1.x`、`0.x`。按「缺省段取 0、末尾段开区间」展开，
    // 与 node-semver 的 x-range 语义一致。
    const wild = /^(\^|~|>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(normalized);
    if (wild !== null && /[xX*]/.test(normalized)) {
        const op = wild[1] ?? '=';
        const major = Number(wild[2]);
        const minorPart = wild[3];
        const patchPart = wild[4];
        if (minorPart === undefined || /[xX*]/.test(minorPart)) {
            // 只给了 major：整条主线
            if (op === '^' || op === '~' || op === '=') {
                // 下界带 `-0`：x-range 要匹配该线上的 prerelease（0.2.x 命中 0.2.0-rc.2），
                // 与 node-semver 的 x-range 一致。
                return { lower: { version: `${major}.0.0-0`, inclusive: true }, upper: { version: `${major + 1}.0.0-0`, inclusive: false } };
            }
            return null;
        }
        const minor = Number(minorPart);
        if (patchPart === undefined || /[xX*]/.test(patchPart)) {
            if (op === '^' || op === '~' || op === '=') {
                return { lower: { version: `${major}.${minor}.0-0`, inclusive: true }, upper: { version: `${major}.${minor + 1}.0-0`, inclusive: false } };
            }
        }
        return null;
    }

    const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(normalized);
    if (m === null) return null;
    const op = m[1] ?? '=';
    const v = parse(m[2]);
    if (v === null) return null;
    switch (op) {
        case '^':
            return { lower: { version: v.raw, inclusive: true }, upper: { version: caretUpper(v), inclusive: false } };
        case '~':
            return { lower: { version: v.raw, inclusive: true }, upper: { version: tildeUpper(v), inclusive: false } };
        case '>=':
            return { lower: { version: v.raw, inclusive: true }, upper: null };
        case '>':
            return { lower: { version: v.raw, inclusive: false }, upper: null };
        case '<=':
            return { lower: null, upper: { version: v.raw, inclusive: true } };
        case '<':
            return { lower: null, upper: { version: v.raw, inclusive: false } };
        default:
            return { lower: { version: v.raw, inclusive: true }, upper: { version: v.raw, inclusive: true } };
    }
}

/**
 * 判断一个版本是否满足区间。
 *
 * 支持：`||` 或、空格分隔的与、`^ ~ >= <= > < =` 及裸版本。
 * 无法解析的区间返回 **false**（保守）—— 兼容层的立场是「拿不准就不放行」，
 * 把不确定当成满足会让真正坏掉的插件混进去。
 *
 * @param {string} version 宿主版本，通常是 prerelease（0.2.1-rc.4）
 * @param {string} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
    if (!isExact(version)) return false;
    if (typeof range !== 'string' || range.trim() === '') return false;
    // 先吃掉「操作符 + 空格」：`>= 0.1.5` 按空格分割会变成两段（`>=` 与 `0.1.5`），
    // 那样第一段解析失败 → 整条区间被判不满足。node-semver 接受这种写法。
    const normalized = range.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1');
    for (const alternative of normalized.split('||')) {
        const parts = alternative.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) continue;
        let ok = true;
        for (const part of parts) {
            const bounds = expandComparator(part);
            if (bounds === null) { ok = false; break; }
            if (bounds.lower !== null) {
                const c = compare(version, bounds.lower.version);
                if (c < 0 || (c === 0 && !bounds.lower.inclusive)) { ok = false; break; }
            }
            if (bounds.upper !== null) {
                const c = compare(version, bounds.upper.version);
                if (c > 0 || (c === 0 && !bounds.upper.inclusive)) { ok = false; break; }
            }
        }
        if (ok) return true;
    }
    return false;
}

/**
 * 区间是否可解析（用于区分「明确不满足」与「看不懂」）。
 * @param {string} range
 * @returns {boolean}
 */
export function isRange(range) {
    if (typeof range !== 'string' || range.trim() === '') return false;
    const normalized = range.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1');
    return normalized.split('||').every((alt) => {
        const parts = alt.trim().split(/\s+/).filter(Boolean);
        return parts.length > 0 && parts.every((p) => expandComparator(p) !== null);
    });
}

/** 取出区间的 `major.minor` 声明线，用于「跨线」判断。 */
export function declaredLines(range) {
    const lines = [];
    if (typeof range !== 'string') return lines;
    for (const alternative of range.split('||')) {
        for (const raw of alternative.trim().split(/\s+/).filter(Boolean)) {
            const m = /^(\^|~)\s*(\d+)\.(\d+)\./.exec(raw);
            if (m !== null) lines.push(`${m[2]}.${m[3]}`);
        }
    }
    return [...new Set(lines)];
}
