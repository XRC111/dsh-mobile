/**
 * @dsh-android/link —— DSH 远程联动（手机侧）。
 *
 * ── 它是拨号方 ──────────────────────────────────────────────────────────────
 * 手机主动连桌面，而不是等桌面连进来。原因：
 *   · 手机的局域网地址会变（切 Wi-Fi、DHCP 续租），桌面存不住；
 *   · 手机端不该为了这个功能开入站端口 —— 那是把攻击面平白放大；
 *   · 拨号方天然知道「我对谁负责」，重连逻辑简单。
 *
 * ── 配对 ────────────────────────────────────────────────────────────────────
 * 首次：桌面上跑 link_host_start 拿到 6 位配对码 → 在手机上
 *       link_connect { host, port, code } → 桌面发放长期令牌 → 手机存进
 *       $DSH_HOME/link/client.json → 之后只写 host/port 即可自动用令牌重连。
 *
 * ── 它提供什么、消费什么 ────────────────────────────────────────────────────
 * 提供（供桌面调用）：mobile.*，直接复用已有的 @dsh-android/mobile-use 的文件桥
 *   —— 无障碍服务的实现只有一份，这里不重写，否则两处行为迟早不一致。
 * 消费（调用桌面）：computer.* / session.* / model.* —— 桌面那头实现。
 *
 * ── 缺 mobile-use 时怎么办 ──────────────────────────────────────────────────
 * 用动态 import + 优雅降级：mobile-use 没装或没启用时，联动本身照常工作
 * （手机仍然能操作桌面），只是桌面调 mobile.* 会报一句清楚的话。
 * 反过来若在顶层静态 import，缺它会让整个联动插件加载失败 —— 那是更差的失败模式。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { connectToHost } from './link-protocol/endpoint.js';
import { MOBILE_METHODS, DEFAULT_PORT, fileChunks } from './link-protocol/protocol.js';
import { open } from './link-protocol/secret.js';
import { registerRoutes } from './link-protocol/routes.js';
import { RELAY_METHOD, REMOTE_PROVIDER, REMOTE_PROVIDER_LABEL, RELAY_POLICY } from './link-protocol/llmrelay.js';

/**
 * 连接方式。
 *
 * 两种方式在**网络层没有区别** —— 都是往某个 host:port 发一个 TCP 连接。
 * 区分它们是**为了在填错时能立刻指出**：
 *   · 直连：填桌面的真实地址（局域网 IP / 公网 IPv6 / 组网工具的虚拟 IP）
 *   · 端口转发：EasyTier 的 --port-forward（或 ssh -L）把远端端口映射成了
 *     **本机**的一个端口，这时必须填 127.0.0.1。
 *
 * 把这两种搞混是最容易犯的错（填了 127.0.0.1 却没开转发 → 连到手机自己 → 报
 * 「连接被拒绝」，而用户完全看不出为什么）。所以这里做交叉校验，报错说清原因。
 */
const MODES = {
    direct: {
        id: 'direct',
        label: '直连',
        hint: '填桌面的真实地址：局域网 IP、公网 IPv6，或组网工具给的虚拟 IP。',
    },
    forward: {
        id: 'forward',
        label: '端口转发',
        hint: '把远端端口映射到了本机（如 EasyTier --port-forward），这里填 127.0.0.1 与映射出来的本地端口。',
    },
};

/**
 * 判断地址是否是本机回环。
 * @param {string} host - 地址。
 * @returns {boolean} 是否回环。
 */
function isLoopback(host) {
    const h = String(host ?? '').trim().toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/**
 * 交叉校验「连接方式」与填的地址是否自洽。
 *
 * 这是本功能的主要价值：两种模式填错的表现都是「连不上」，而原因完全不同。
 * 与其让用户对着 "ECONNREFUSED" 猜，不如在发起连接前就说明白。
 *
 * @param {string} mode - 'direct' | 'forward'。
 * @param {string} host - 用户填的地址。
 * @returns {string|null} 警告文案；自洽时返回 null。
 */
function validateMode(mode, host) {
    if (mode === 'forward' && !isLoopback(host)) {
        return '端口转发模式下应该填 127.0.0.1 —— 转发是把远端端口映射到**本机**，'
            + '所以你连的是本机地址。你填的是 ' + host + '。'
            + '如果确实要直连桌面，请把连接方式改成「直连」。';
    }
    if (mode === 'direct' && isLoopback(host)) {
        return '直连模式下填了回环地址 —— 这会连到手机自己，不是桌面。'
            + '如果你已经用 EasyTier/ssh 把桌面端口映射到了本机，请把连接方式改成「端口转发」。';
    }
    return null;
}

const textOut = (props) => ({
    schema: { type: 'object', additionalProperties: false, properties: props },
    render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
});

/**
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 配置。
 */
function apply(ctx, config = {}) {
    const log = (msg) => ctx.logger?.info?.('[link] ' + msg) ?? console.log('[link] ' + msg);
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const stateFile = path.join(home, 'link', 'client.json');

    /** @type {{conn: any, saved: object, mobile: any, mobileError: string|null}} */
    const state = { conn: null, saved: {}, mobile: null, mobileError: null };

    /** 载入已保存的配对信息。 */
    async function loadSaved() {
        try {
            state.saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        } catch { state.saved = {}; }
        return state.saved;
    }

    /** 保存配对信息。 */
    async function save(extra) {
        state.saved = { ...state.saved, ...extra };
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify(state.saved, null, 2), 'utf8');
    }

    /**
     * 惰性载入 mobile-use 的桥。
     * @returns {Promise<object|null>} MobileUseBridge 实例，或 null（并记下原因）。
     */
    async function mobileBridge() {
        if (state.mobile) return state.mobile;
        if (state.mobileError) return null;
        try {
            const mod = await import('@dsh-android/mobile-use');
            state.mobile = new mod.MobileUseBridge(mod.bridgeDir());
        } catch (error) {
            state.mobileError = 'mobile-use 不可用：' + (error?.message ?? error);
        }
        return state.mobile;
    }

    /**
     * 调一次 mobile-use，并把 !ok 转成抛错。
     * @param {string} op - 操作名。
     * @param {object} args - 参数。
     * @param {object} [options] - 超时等。
     * @returns {Promise<object>} 服务返回。
     */
    async function mobileCall(op, args = {}, options = {}) {
        const bridge = await mobileBridge();
        if (!bridge) throw new Error(state.mobileError ?? 'mobile-use 不可用');
        const result = await bridge.call(op, args, options);
        if (result && result.ok === false) throw new Error('mobile_use ' + op + '：' + (result.error ?? '未知错误'));
        return result;
    }

    /** 把 mobile.* 注册到连接上，供桌面调用。 */
    function registerMobileMethods(conn) {
        conn.handle('mobile.status', () => mobileCall('status', {}, { timeoutMs: 8000 }));
        conn.handle('mobile.screen_shot', async () => {
            const shot = await mobileCall('screenshot', {}, { timeoutMs: 15_000 });
            // 服务的返回里 png 是**文件路径**（无障碍服务的实现写盘后回路径），
            // 链路是 JSON 不能带二进制，所以这里读出来转 base64。
            const bytes = fsSync.readFileSync(shot.path);
            return { width: shot.width, height: shot.height, bytes: bytes.length, png: bytes.toString('base64') };
        });
        conn.handle('mobile.screen_elements', ({ filter, max } = {}) => mobileCall('nodes', { filter, max }, { timeoutMs: 15_000 }));
        conn.handle('mobile.click', ({ x, y, double } = {}) => mobileCall('tap', { x, y, double }, { timeoutMs: 12_000 }));
        conn.handle('mobile.scroll', ({ delta } = {}) => mobileCall('swipe', { delta }, { timeoutMs: 12_000 }));
        conn.handle('mobile.type', ({ text } = {}) => mobileCall('text', { text }, { timeoutMs: 12_000 }));
        conn.handle('mobile.key', ({ keys } = {}) => mobileCall('key', { keys }, { timeoutMs: 12_000 }));
        // 桌面往手机推文件：落到手机工作区（DSH 的默认 workspace）。
        conn.handle('file.push', async ({ name, chunks, to } = {}) => {
            const base = to
                ?? (process.env.DSH_ANDROID_FILES_DIR ? path.join(process.env.DSH_ANDROID_FILES_DIR, 'workspace') : os.tmpdir());
            const target = path.join(base, path.basename(String(name ?? 'file.bin')));
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, Buffer.concat((chunks ?? []).map((c) => Buffer.from(c, 'base64'))));
            return { path: target, bytes: (await fs.stat(target)).size };
        });
    }

    /**
     * 连接桌面。
     * @param {object} args - { host, port, code }。
     * @returns {Promise<object>} 连接结果摘要。
     */
    async function connect(args) {
        await loadSaved();
        const host = args.host ?? state.saved.host;
        const port = args.port ?? state.saved.port ?? DEFAULT_PORT;
        // 连接方式：没传就沿用上次的（或按地址猜一个合理默认）。
        const mode = MODES[args.mode] ? args.mode : (state.saved.mode ?? (isLoopback(host) ? 'forward' : 'direct'));
        if (!host) throw new Error('需要 host（桌面地址）。先在桌面上跑 link_host_start，它会列出地址。');
        // 交叉校验：填错时立刻说清，而不是等一个 ECONNREFUSED。
        const warning = validateMode(mode, host);
        if (warning && args.strict !== false) {
            throw new Error(warning);
        }
        const code = args.code;
        const token = code ? undefined : state.saved.token;
        if (!code && !token) throw new Error('第一次配对需要在桌面上拿配对码，然后用 link_connect 传 code。');

        if (state.conn && !state.conn.closed) state.conn.close('reconnect');
        const conn = await connectToHost({
            host, port, code, token,
            device: { name: os.hostname(), platform: 'android-' + process.arch },
            methods: [...MOBILE_METHODS, 'file.push'],
            log,
        });
        state.conn = conn;
        conn.on('close', () => { if (state.conn === conn) state.conn = null; });
        registerMobileMethods(conn);
        // 记下对端是否宣告了 llm.relay —— 决定"经另一台设备调用"该不该出现。
        peerOffersRelay = (conn.peerMethods ?? []).includes(RELAY_METHOD);
        // 桌面对首次配对会发放长期令牌，存下来供重连。mode 也一起存，
        // 这样重连时不必再问用户"上次是怎么连的"。
        await save({ host, port, mode, ...(conn.issuedToken ? { token: conn.issuedToken } : {}) });
        return {
            connected: true,
            host, port,
            mode,
            modeLabel: MODES[mode].label,
            desktop: conn.peer,
            encrypted: Boolean(conn.sessionKey),
            issuedToken: Boolean(conn.issuedToken),
            desktopMethods: conn.peerMethods,
        };
    }

    /**
     * 把请求转发到对端，并把远端产生的 chunk 逐块交回本地消费方。
     *
     * waterfall 的监听器必须返回 AsyncIterable<StreamChunk>，所以这里把
     * 回调式的事件流包成一个异步生成器。
     *
     * ⚠️ 队列不能丢：远端是"边算边发"，本地在 await 生成器时才拉取。若只留
     *    最后一个值，用户看到的就是"等半天整段蹦出来" —— 那正是我们要避免的。
     *
     * @param {object} conn - 已配对的连接。
     * @param {object} options - 原始 GenerateOptions（原样转发，不裁剪字段）。
     * @returns {AsyncGenerator<object>} 远端的 chunk。
     */
    async function* relayStream(conn, options) {
        /** @type {object[]} 等待消费的 chunk。 */
        const queue = [];
        let done = false;
        let failure = null;
        let wake = null;
        const push = (chunk) => { queue.push(chunk); wake?.(); wake = null; };
        const finish = (error) => { if (error) failure = error; done = true; wake?.(); wake = null; };

        // 远端结束或失败时，结束整个生成器。
        const settled = conn.callStream(RELAY_METHOD, options, push).then(
            () => finish(null),
            (error) => finish(error),
        );

        try {
            for (;;) {
                while (queue.length > 0) yield queue.shift();
                if (done) break;
                await new Promise((resolve) => { wake = resolve; });
            }
            while (queue.length > 0) yield queue.shift();
            if (failure) throw failure;
        } finally {
            // 本地消费方提前退出（用户取消 / 会话中断）时结束这次转发。
            // settled 只是用来兜住"远端还没结束就走了"的 rejection，
            // 不 await —— await 它会把取消也变成等待。
            settled.catch(() => {});
        }
    }

    /** 取当前连接，没有就报清楚。 */
    function requireConn() {
        if (!state.conn || state.conn.closed) throw new Error('还没连接桌面。先跑 link_connect（首次需要配对码）。');
        return state.conn;
    }

    /**
     * 切换远程凭据转发。
     *
     * 工具与 HTTP 路由共用这一份，避免两条路径状态不一致。
     *
     * @param {object} args - { enabled?, policy? }。
     * @returns {object} 切换后的状态。
     */
    function toggleRelay(args = {}) {
        if (typeof args.enabled === 'boolean') remoteEnabled = args.enabled;
        if (typeof args.policy === 'string' && Object.values(RELAY_POLICY).includes(args.policy)) {
            remotePolicy = args.policy;
        }
        return opStatus().llmRelay;
    }

    /** 状态：工具与 GUI 路由共用同一份。 */
    function opStatus() {
        return {
            connected: Boolean(state.conn && !state.conn.closed),
            // 远程凭据转发：默认关闭，且必须显式开启（对话内容会离开本机）。
            llmRelay: {
                enabled: remoteEnabled,
                policy: remotePolicy,
                provider: REMOTE_PROVIDER,
                providerLabel: REMOTE_PROVIDER_LABEL,
                connected: Boolean(state.conn && !state.conn.closed),
                // 对端没有宣告 llm.relay 时，开着也没用 —— 明说，别让人以为配好了。
                peerOffersRelay,
                available: Boolean(state.conn && !state.conn.closed && peerOffersRelay),
                note: !peerOffersRelay
                    ? '桌面未宣告转发能力（它可能没启用 llm 服务）。'
                    : remoteEnabled
                        ? '已开启：本地无法执行的模型调用会转发到桌面执行。'
                        : '默认关闭。开启后，**对话内容会发到桌面**执行。',
            },
            desktop: state.conn?.peer ?? null,
            encrypted: Boolean(state.conn?.sessionKey),
            desktopMethods: state.conn?.peerMethods ?? [],
            savedHost: state.saved.host ?? null,
            savedPort: state.saved.port ?? null,
            mode: state.saved.mode ?? 'direct',
            modeLabel: MODES[state.saved.mode ?? 'direct'].label,
            modeHint: MODES[state.saved.mode ?? 'direct'].hint,
            hasToken: Boolean(state.saved.token),
            note: state.conn ? null : '未连接。先填桌面地址与配对码。',
        };
    }

    // ── 远程凭据转发（默认关闭）─────────────────────────────────────────────
    //
    // 机制：拦截 `llm/stream` waterfall（每次模型调用必经，见 dsh-llm 的
    // streamWithRegistration）。所以**插件注入的 provider 也一并覆盖** —— 它在
    // adapter 之上，不需要逐个适配。
    //
    // ⚠️ 为什么不直接用 ctx.tools.execute 那类入口：那是给模型用的分发工具，
    //    绕不开它自己的前置检查；waterfall 才是「每次模型调用必经」的正式接缝。
    //
    // 策略 B：本地能跑就本地跑（快、少一跳），否则转发。
    let remoteEnabled = false;
    let remotePolicy = RELAY_POLICY.localFirst;
    /** 对端（桌面）是否宣告了 llm.relay。配对时刷新。 */
    let peerOffersRelay = false;
    ctx.effect(() => {
        if (!ctx.get('llm')) return;
        // 让 "经另一台设备调用" 出现在模型选择器里。
        ctx.llm.registerConfigurableProviders([{
            provider: REMOTE_PROVIDER,
            displayName: REMOTE_PROVIDER_LABEL,
            settingsNs: ctx.fiber?.entry?.options?.id ?? 'dsh-android-link',
            settingsPath: [],
        }]);
        // 转发器：命中且允许转发时短路，替换默认路由。
        const forward = (options, next) => {
            // 没开启转发、或这个 provider 本来就是"经另一台设备调用"，
            // 都按原样本地走。
            if (!remoteEnabled || !options || options.provider === REMOTE_PROVIDER) return next();
            const conn = state.conn;
            if (!conn || conn.closed) {
                // 没连上桌面就**明确报错**。这里若回落 next()，用户会看到
                // "本地没凭据"这类误导性错误，而真正的原因是没配对。
                const e = new Error('未连接到桌面，无法转发模型调用。请先在「远程联动」里配对，或关闭转发。');
                e.code = 'NO_REMOTE_LINK';
                throw e;
            }
            return relayStream(conn, options);
        };
        ctx.on('llm/stream', forward);
        return () => ctx.off('llm/stream', forward);
    }, 'dsh-link: llm relay');

    // GUI 用的 HTTP 路由（挂在已鉴权的 Connection 上）。
    // 手机外壳页面通过本机 dsh 的地址调它们 —— 不用让用户在对话里敲 JSON。
    registerRoutes(ctx, {
        status: async () => { await loadSaved(); return opStatus(); },
        // 开关远程转发。默认 false —— 这是**明确的选择**，不是默认值忘了写。
        llmRelay: async (body) => toggleRelay(body),
        connect: (body) => connect(body ?? {}),
        stop: async () => { state.conn?.close('user requested'); state.conn = null; return { connected: false }; },
    });

    const tools = [
        {
            name: 'link_llm_relay',
            description:
                '远程凭据转发：本地无法执行的模型调用改由桌面用自己的凭据执行（**对话内容会发到桌面**）。默认关闭，需显式开启。',
            parameters: {
                enabled: { type: 'boolean', required: true, description: 'true 开启，false 关闭。' },
                policy: { type: 'string', description: '策略：local-first（本地优先，默认）或 always-remote（全部转发）。' },
            },
            async execute(args) {
                return toggleRelay(args);
            },
        },
        {
            name: 'link_connect',
            description: '连接到桌面并配对。首次需要桌面上的 6 位配对码（link_host_start 会给）；之后只写 host/port 就会用已保存的令牌自动重连。mode=forward 时表示走端口转发（如 EasyTier），host 应填 127.0.0.1。',
            parameters: {
                host: { type: 'string', description: '桌面在局域网上的地址，如 192.168.1.10。' },
                port: { type: 'integer', description: '端口，默认 45731。' },
                code: { type: 'string', description: '6 位配对码（仅首次配对需要）。' },
            },
            required: ['host'],
            async execute(args) { return connect(args); },
        },
        {
            name: 'link_status',
            description: '查看与桌面的联动状态：是否已连接、对端是谁、链路是否已建立会话密钥、对端提供哪些方法。',
            parameters: {},
            async execute() { await loadSaved(); return opStatus(); },
        },
        {
            name: 'link_disconnect',
            description: '断开与桌面的联动连接（保留已保存的配对令牌，下次可直接重连）。',
            parameters: {},
            async execute() {
                state.conn?.close('user requested');
                state.conn = null;
                return { connected: false };
            },
        },
        // ── 操作桌面 ────────────────────────────────────────────────────────
        {
            name: 'desktop_status',
            description: '查看已配对桌面的状态（屏幕尺寸、前台窗口、光标位置）。',
            parameters: {},
            async execute() { return requireConn().call('computer.status'); },
        },
        {
            name: 'desktop_screen_shot',
            description: '截取已配对桌面的屏幕（可选指定窗口）。',
            parameters: { hwnd: { type: 'string', description: '窗口句柄，省略为全屏。' } },
            async execute(args) { return requireConn().call('computer.screen_shot', args, { timeoutMs: 30_000 }); },
        },
        {
            name: 'desktop_screen_windows',
            description: '列出已配对桌面上的可见窗口。',
            parameters: {},
            async execute() { return requireConn().call('computer.screen_windows'); },
        },
        {
            name: 'desktop_click',
            description: '在已配对桌面上点击一个坐标。',
            parameters: {
                x: { type: 'integer', required: true, description: '横坐标。' },
                y: { type: 'integer', required: true, description: '纵坐标。' },
                button: { type: 'string', description: 'left / right / middle，默认 left。' },
                double: { type: 'boolean', description: '是否双击。' },
            },
            async execute(args) { return requireConn().call('computer.click', args); },
        },
        {
            name: 'desktop_type',
            description: '在已配对桌面的当前焦点窗口里输入文本（支持中文，走 Unicode 注入）。',
            parameters: { text: { type: 'string', required: true, description: '要输入的文字。' } },
            async execute(args) { return requireConn().call('computer.type', args); },
        },
        {
            name: 'desktop_key',
            description: '在已配对桌面上按键。给 keys 走组合键（如 ["ctrl","c"]），或给 vk 直接按键码。',
            parameters: {
                keys: { type: 'array', items: { type: 'string' }, description: '键名数组。' },
                vk: { type: 'integer', description: '虚拟键码。' },
            },
            async execute(args) { return requireConn().call('computer.key', args); },
        },
        // ── 桌面会话 ────────────────────────────────────────────────────────
        {
            name: 'desktop_sessions',
            description: '列出桌面上的 DSH 会话（最近修改在前）。',
            parameters: {},
            async execute() { return requireConn().call('session.list', {}, { timeoutMs: 30_000 }); },
        },
        {
            name: 'desktop_session_read',
            description: '读取桌面上某个会话的原始日志（分块 base64），并落到手机本地文件。',
            parameters: { id: { type: 'string', required: true, description: '会话 id。' } },
            async execute(args) {
                const res = await requireConn().call('session.read', args, { timeoutMs: 120_000 });
                const dir = path.join(home, 'link', 'remote-sessions');
                await fs.mkdir(dir, { recursive: true });
                const file = path.join(dir, res.id + '.jsonl.zstd');
                await fs.writeFile(file, Buffer.concat((res.chunks ?? []).map((c) => Buffer.from(c, 'base64'))));
                return { id: res.id, project: res.project, path: file, chunks: (res.chunks ?? []).length };
            },
        },
        // ── 文件 / 模型 ─────────────────────────────────────────────────────
        {
            name: 'link_push_file',
            description: '把手机上的一个文件推到已配对桌面的工作区。',
            parameters: {
                path: { type: 'string', required: true, description: '手机上的文件路径。' },
                to: { type: 'string', description: '桌面上的目标目录（省略则用桌面工作区）。' },
            },
            async execute(args) {
                const data = await fs.readFile(args.path);
                return requireConn().call('file.push', {
                    name: path.basename(args.path),
                    to: args.to ?? null,
                    chunks: fileChunks(data),
                }, { timeoutMs: 120_000 });
            },
        },
        {
            name: 'link_pull_model',
            description: '从已配对桌面拉取模型配置。includeCredentials=true 时连 API Key 一起拉（凭据走会话密钥加密，明文链路不传 Key）。',
            parameters: { includeCredentials: { type: 'boolean', description: '是否一并拉取凭据（API Key）。' } },
            async execute(args) {
                const conn = requireConn();
                const res = await conn.call('model.export', { includeCredentials: Boolean(args.includeCredentials) }, { timeoutMs: 60_000 });
                const written = await applyModel(res, conn);
                return { files: written, credentials: Boolean(res.credentials), note: res.note ?? null };
            },
        },
    ];

    for (const spec of tools) {
        ctx.tools.register(defineTool({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters ?? {},
            output: textOut({}),
            async execute(args) { return spec.execute(args ?? {}); },
            presentCall: () => ({ card: 'generic', title: spec.name, kind: 'read', rawInput: {} }),
        }));
    }

    /**
     * 把拉到的模型配置写进本机 DSH home。
     *
     * ⚠️ 覆盖前一律留 .linkbak 备份。写坏用户凭据的代价远大于多留一个文件。
     *
     * @param {object} res - 桌面的 model.export 返回。
     * @param {object} conn - 连接（取会话密钥解凭据）。
     * @returns {Promise<string[]>} 写入的相对路径。
     */
    async function applyModel(res, conn) {
        const written = [];
        for (const f of res.files ?? []) {
            const rel = String(f.path ?? '');
            // 白名单：只允许写模型目录与凭据文件，且不允许跳出 home。
            if (!/^(llm-[a-z0-9-]+\/[^/]+|\.credentials\.yaml)$/i.test(rel)) {
                throw new Error('拒绝写入路径 ' + rel);
            }
            const target = path.join(home, rel);
            if (!path.resolve(target).startsWith(path.resolve(home))) throw new Error('路径越界：' + rel);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(target, target + '.linkbak').catch(() => {});
            await fs.writeFile(target, String(f.content ?? ''), 'utf8');
            written.push(rel);
        }
        if (res.credentials) {
            if (!conn.sessionKey) throw new Error('本次连接没有会话密钥，拒绝接收凭据');
            const opened = open(conn.sessionKey, res.credentials);
            for (const [rel, content] of Object.entries(opened)) {
                const target = path.join(home, rel);
                await fs.copyFile(target, target + '.linkbak').catch(() => {});
                await fs.writeFile(target, content, 'utf8');
                written.push(rel);
            }
        }
        return written;
    }

    // 启动时尝试用已保存的令牌自动重连 —— 省得每次开 App 都要手动连。
    // 失败只记一条日志：没人在旁边看着启动过程，不该因此让插件加载失败。
    void (async () => {
        try {
            await loadSaved();
            if (state.saved.host && state.saved.token) {
                await connect({});
                log('已用保存的令牌自动重连到 ' + state.saved.host + ':' + state.saved.port);
            }
        } catch (error) {
            log('自动重连未成功（不影响本地使用）：' + (error?.message ?? error));
        }
    })();
}

export const name = '@dsh-android/link';
export const inject = ['tools', 'connection', 'llm'];

export { apply };
