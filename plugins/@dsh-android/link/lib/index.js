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
import { TRANSIT_METHOD, TRANSIT_STREAM_METHOD } from './link-protocol/protocol.js';
import { MOBILE_METHODS, DEFAULT_PORT, fileChunks } from './link-protocol/protocol.js';
import { open } from './link-protocol/secret.js';
import { registerRoutes } from './link-protocol/routes.js';
import { RELAY_METHOD, REMOTE_PROVIDER, REMOTE_PROVIDER_LABEL, RELAY_POLICY, RELAY_ADVERTISED, LIST_METHOD, LIST_ADVERTISED, relayStream } from './link-protocol/llmrelay.js';
import { loadOrCreateIdentity, TOPOLOGY } from './link-protocol/mesh-identity.js';
import { Registry } from './link-protocol/mesh-registry.js';
import { LinkManager, shouldDial } from './link-protocol/mesh-manager.js';

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

    /**
     * 本端对外宣告的能力。
     *
     * ⚠️ 两处必须一致（LinkManager 的 capabilities 与 connectToHost 的 methods）：
     *    前者决定「别人连进来时看到我能做什么」，后者决定「我拨出去时告诉对方我能做什么」。
     *    分两份写迟早走样 —— 一边加了 file.push 另一边没加，表现就是同一个功能
     *    「别人连我时可用、我连别人时不可用」，而两边代码看着都对。
     *
     * 含 TRANSIT_METHOD：谁同时连着两台设备，谁就能当中转。手机在 star 里不是
     * 中转方，但 mesh 下可能成为，所以能力一并宣告 —— 用不用由调用方按当前
     * 连接情况决定。
     */
    const MOBILE_CAPS = [...MOBILE_METHODS, 'file.push', TRANSIT_METHOD];

    // ── mesh 核心：我是谁 / 我认识谁 / 现在连上了谁 ──────────────────────────
    //
    // 这一层把原先「固定一对一」升级成「一台设备面对 N 台」：
    //   identity —— 稳定 deviceId（公钥指纹）+ 密钥对，落 $DSH_HOME/link/identity.json
    //   registry —— 已配对设备清单，落 $DSH_HOME/link/registry.json
    //   manager  —— 运行期连接集合 + 拨号仲裁
    //
    // ⚠️ 身份载入失败**不能**让插件加载失败：手机可能在只读目录下跑。
    //    loadOrCreateIdentity 自己吞掉写盘错误，这里再兜一层。
    let identity = null;
    let registry = null;
    let mesh = null;
    try {
        identity = loadOrCreateIdentity(home, os.hostname(), 'mobile');
        registry = new Registry(home, identity.deviceId);
        mesh = new LinkManager({
            deviceId: identity.deviceId,
            identity,
            registry,
            name: os.hostname(),
            kind: 'mobile',
            capabilities: MOBILE_CAPS,
            // homeDir 让管理器把「本端签发过的令牌」落盘 —— 不落盘的话进程一重启
            // 对方拿着有效令牌也连不进来，只能重新配对，而配对码是一次性的。
            homeDir: home,
            log,
        });
    } catch (error) {
        log('mesh 身份初始化失败（联动退化为单连接模式）：' + (error?.message ?? error));
    }

    /**
     * 切换拓扑并**让驱动跟着变**。
     *
     * 只调 mesh.setTopology() 是不够的：那只是记下模式，真正让它生效的是
     * 自动连接驱动（监听 + 周期性拨号）。切到 mesh 时要把它起起来，
     * 切回 star 时要停掉监听 —— 否则手机在 star 下也开着入站端口，
     * 平白放大攻击面，而 star 的设计前提正是「手机不做入站」。
     *
     * @param {string} topology - 'star' | 'mesh'。
     * @returns {Promise<object>} 切换后的状态。
     */
    async function applyTopology(topology) {
        if (!mesh) throw new Error('mesh 未启用（身份初始化失败）');
        const next = mesh.setTopology(topology);
        if (next === 'mesh') {
            await mesh.startAutoConnect({
                intervalMs: 5000,
                onConnection: (c) => registerMobileMethods(c),
            });
        } else {
            await mesh.stopAutoConnect();
        }
        return {
            topology: mesh.topology,
            dialTargets: mesh.dialTargets().map((r) => r.deviceId),
        };
    }

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
        // ⚠️ 这里必须是四个坐标。Kotlin 侧的 swipe() 读的是 x1/y1/x2/y2，
        // 传 delta 会得到 "swipe 需要 x1 / y1 / x2 / y2"。
        // delta → 坐标的换算放在**桌面侧**（那里拿得到屏幕尺寸）。
        conn.handle('mobile.scroll', ({ x1, y1, x2, y2 } = {}) => mobileCall('swipe', { x1, y1, x2, y2 }, { timeoutMs: 12_000 }));
        conn.handle('mobile.type', ({ text } = {}) => mobileCall('text', { text }, { timeoutMs: 12_000 }));
        // ⚠️ 必须是 { name }（单数字符串）。Kotlin 的 globalKey() 读 args.name，
        // 传 keys 会得到 "未知按键：（空）"。
        conn.handle('mobile.key', ({ name } = {}) => mobileCall('key', { name }, { timeoutMs: 12_000 }));
        // 中转：本机同时连着两台设备时，代其中一台把调用转到另一台。
        // 手机在 mesh 里也可能扮演这个角色（比如两台手机都连着本机）。
        conn.handle(TRANSIT_METHOD, (a) => mesh.relayCall(a));
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
            device: { name: os.hostname(), platform: 'android-' + process.arch, deviceId: identity?.deviceId, kind: 'mobile' },
            methods: MOBILE_CAPS,
            log,
        });
        state.conn = conn;
        conn.on('close', () => { if (state.conn === conn) state.conn = null; });
        registerMobileMethods(conn);
        // 记进 mesh：这样 link_devices 能看到它、拨号仲裁也知道这台已经连上了。
        // 对端 deviceId 来自握手时的 device 描述；老版本对端不带它时跳过 ——
        // 连接仍然可用，只是无法参与 mesh 的去重与寻址。
        if (mesh && conn.peer?.deviceId) {
            mesh.track('out', conn.peer.deviceId, conn);
            mesh.notePeer({
                deviceId: conn.peer.deviceId,
                name: conn.peer.name,
                kind: conn.peer.kind,
                endpoint: host + ':' + port,
                capabilities: conn.peerMethods,
                // ⚠️ 令牌必须一并写进注册表：mesh.dial() 是从注册表读 rec.token 去重连的，
                //    只存进 client.json 的话，自动重拨会以「没有令牌」失败 ——
                //    而配对码是一次性的，等于每次都要人跑去桌面点「换一个配对码」。
                ...(conn.issuedToken ? { token: conn.issuedToken } : {}),
            });
        }
        // 记下对端是否宣告了 llm.relay —— 决定"经另一台设备调用"该不该出现。
        peerOffersRelay = (conn.peerMethods ?? []).includes(RELAY_METHOD);
        // 桌面向导模型列表 —— **异步、不阻塞**连接返回。
        //
        // ⚠️ 刻意不等它：listModels 会真的去问 API（网络往返，可能几秒），
        //    await 下来就是「点连接后界面卡住几秒」。用户要的是立刻看到
        //    「已连接」，模型列表晚几秒补上没关系。
        //
        // 失败也**不**影响连接结果：拿不到列表只是「下拉里少几个模型」，
        // 而让连接失败就完全说不通了。
        if ((conn.peerMethods ?? []).includes(LIST_ADVERTISED)) {
            prefetchRemoteModels(conn).catch((e) => {
                console.warn('[link] 取桌面模型列表失败（不影响连接）：' + e.message);
            });
        }
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
 * 预取桌面的 provider / 模型列表，存成本地快照。
 *
 * ── 为什么是「快照」而不是实时转发 ──────────────────────────────────────────
 * 用户展开模型下拉时读的是这个快照，不产生网络往返。若改成实时转发，
 * 每展开一次都要等一次 `llm.listModels`（那会真的去问 API），下拉会明显卡顿。
 * 代价是列表是连接时刻的快照 —— 对「桌面上有哪些模型」这个问题，
 * 连接期间不会变，够用。
 *
 * ── 不注册成本地 provider 的原因 ────────────────────────────────────────────
 * 本机没有桌面的凭据，注册一个同名 provider 只会在真正调用时报错，
 * 还可能遮住本机同名的真 provider。所以这里**只做展示**：列表里出现
 * 「经电脑：xxx」，实际调用仍走 `llm.remote`（凭据不出本机）。
 *
 * @param {object} conn 已建立的连接。
 * @returns {Promise<{providers: string[], models: Record<string, any[]>, at: number}>}
 */
async function prefetchRemoteModels(conn) {
        const res = await conn.call(LIST_METHOD, {});
        const providers = Array.isArray(res?.providers) ? res.providers : [];
        const models = res?.models && typeof res.models === 'object' ? res.models : {};
        // 汇总成一张「provider → 模型名」的表给界面用。
        const flat = [];
        for (const p of providers) {
            for (const m of models[p] ?? []) {
                flat.push({
                    provider: p,
                    // 模型项可能是字符串，也可能是 { id, name }（桌面侧做过裁剪）。
                    id: typeof m === 'string' ? m : m.id,
                    label: typeof m === 'string' ? m : (m.name ?? m.id),
                });
            }
        }
        remoteModels = { providers, models, flat, at: Date.now() };
        return remoteModels;
    }

    /** 取当前连接，没有就报清楚。 */
    function requireConn() {
        if (!state.conn || state.conn.closed) throw new Error('还没连接桌面。先跑 link_connect（首次需要配对码）。');
        return state.conn;
    }

    /**
     * 按 deviceId（或设备名）找一条可用连接。
     *
     * 支持按名字匹配是为了好用：deviceId 是 16 位十六进制，没人愿意手抄。
     * 名字歧义时**明确报错**而不是随便挑一台 —— 操作错设备（点错鼠标）比报错严重。
     *
     * @param {string} key - deviceId 或设备名。
     * @returns {object} 连接。
     */
    function resolveDevice(key) {
        if (!mesh) throw new Error('mesh 未启用（身份初始化失败）');
        const wanted = String(key ?? '').trim();
        if (!wanted) throw new Error('需要 device（link_devices 里能看到 deviceId）');
        // 1) 精确 deviceId
        const direct = mesh.connectionTo(wanted);
        if (direct && !direct.closed) return direct;
        // 2) 按名字匹配（已配对的清单里找）
        const byName = (registry?.list() ?? []).filter((r) => r.name === wanted);
        if (byName.length === 1) {
            const conn = mesh.connectionTo(byName[0].deviceId);
            if (conn && !conn.closed) return conn;
            throw new Error('设备「' + wanted + '」当前不在线。用 link_connect_device 主动连它。');
        }
        if (byName.length > 1) {
            throw new Error('有 ' + byName.length + ' 台设备都叫「' + wanted + '」，请用 deviceId 指定：'
                + byName.map((r) => r.deviceId).join('、'));
        }
        throw new Error('没有已连接的设备「' + wanted + '」。先跑 link_devices 看有哪些。');
    }

    /**
     * 在指定设备上调用一个方法，**连不上就自动走中转**。
     *
     * ── 为什么需要中转 ──────────────────────────────────────────────────────
     * star 拓扑里两台设备（如两台手机）都只连着 hub，彼此没有任何直连路径 ——
     * 它们之间要互通，只能请 hub 代转。这是文档里承诺过、但一直没实现的能力。
     *
     * 顺序：先试直连（快、少一跳），直连不可用再找一台**同时连着目标**的设备当中转。
     * 中转只做一跳（见 mesh-manager 的 relayCall），不会形成链条。
     *
     * @param {string} deviceKey - 目标 deviceId 或设备名。
     * @param {string} method - 要调用的方法。
     * @param {object} args - 方法参数。
     * @returns {Promise<any>} 目标方法的返回值。
     */
    async function invokeWithRelay(deviceKey, method, args) {
        if (!mesh) throw new Error('mesh 未启用（身份初始化失败）');
        // 1) 直连优先
        try {
            return await resolveDevice(deviceKey).call(method, args, { timeoutMs: 60_000 });
        } catch (directError) {
            // 只有「找不到在线连接」才值得试中转；方法本身报错（比如目标拒绝）
            // 要原样抛出去 —— 否则用户看到的是「中转也没成功」，真正的原因被盖掉。
            const msg = String(directError?.message ?? directError);
            const offline = /不在线|没有已连接的设备|unknown device|not connected/.test(msg);
            if (!offline) throw directError;
        }

        // 2) 找一个能当中转的设备：它得连着目标，且宣告了 relay.call。
        //
        // 判据只有「它宣告了中转能力」——不知道它是否真的连着目标（那要问它，
        // 多一次往返不值得）。relayCall 内部会在目标不可达时明确报错，
        // 那时错误里会带上是哪台中转失败的，比事前猜准。
        const targetId = resolveDeviceId(deviceKey);
        const via = mesh.onlinePeers().find((p) => p.deviceId !== targetId
            && (p.capabilities ?? []).includes(TRANSIT_METHOD));
        if (!via) {
            throw new Error('目标设备不在线，且没有可用的中转设备。'
                + '（中转需要一台同时连着你和目标的设备，通常是桌面 hub）');
        }
        return mesh.connectionTo(via.deviceId).call(
            TRANSIT_METHOD,
            { to: targetId, method, args },
            { timeoutMs: 90_000 },
        );
    }

    /**
     * 把 deviceId 或设备名解析成 deviceId（不要求在线）。
     *
     * 与 resolveDevice 的区别：那个要求「现在有活连接」，这个只要求「我认识它」——
     * 中转场景下目标通常**不在线**（这才是要中转的原因）。
     *
     * @param {string} key - deviceId 或设备名。
     * @returns {string} deviceId。
     */
    function resolveDeviceId(key) {
        const wanted = String(key ?? '').trim();
        if (!wanted) throw new Error('需要 device（link_devices 里能看到 deviceId）');
        if (registry?.get(wanted)) return wanted;
        const byName = (registry?.list() ?? []).filter((r) => r.name === wanted);
        if (byName.length === 1) return byName[0].deviceId;
        if (byName.length > 1) {
            throw new Error('有 ' + byName.length + ' 台设备都叫「' + wanted + '」，请用 deviceId 指定。');
        }
        throw new Error('不认识设备「' + wanted + '」。先跑 link_devices 看已配对的有哪些。');
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
            // 桌面上的模型（连接后异步预取的快照）。
            // 放在 llmRelay 旁边而不是独立一块：它们是同一件事的两面 ——
            // 「有哪些模型可选」与「调用时会离开本机」，界面上要一起说明。
            remoteModels: remoteModels
                ? {
                    providers: remoteModels.providers,
                    flat: remoteModels.flat,
                    // 快照时刻，让用户知道这不是实时值。
                    fetchedAt: remoteModels.at,
                    note: '以下模型来自桌面，实际调用仍经桌面执行（凭据不出桌面）。',
                }
                : null,
            savedHost: state.saved.host ?? null,
            savedPort: state.saved.port ?? null,
            mode: state.saved.mode ?? 'direct',
            modeLabel: MODES[state.saved.mode ?? 'direct'].label,
            modeHint: MODES[state.saved.mode ?? 'direct'].hint,
            hasToken: Boolean(state.saved.token),
            // mesh：本机身份 + 已配对设备 + 当前在线。界面据此显示「N 台已配对 / M 台在线」。
            mesh: mesh
                ? {
                    deviceId: identity.deviceId,
                    name: mesh.name,
                    topology: mesh.topology,
                    paired: registry.size,
                    online: mesh.onlinePeers(),
                }
                : null,
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
    /**
     * 桌面的模型列表快照（连接后异步预取）。
     * @type {{providers: string[], models: object, flat: any[], at: number}|null}
     */
    let remoteModels = null;
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
            return relayViaAnyPeer(options);
        };
        ctx.on('llm/stream', forward);
        return () => ctx.off('llm/stream', forward);
    }, 'dsh-link: llm relay');

    /**
     * 把请求转给**任意一台**宣告了模型转发能力的设备。
     *
     * 依次尝试：
     *   1. 直连 —— 目标在线且已宣告 llm.relay（最常见，手机连着桌面）；
     *   2. 经中转 —— 目标只与 hub 相连（两台手机之间就是这样）。
     *      走 `relay.stream`（流式中转），而不是 `relay.call` ——
     *      模型转发是 call-stream，用 call 转不了，那正是它此前失败的原因。
     *
     * 每一步失败都带着下一步的成因继续往下找，全失败才报错，且错误里列出
     * 「试过谁」—— 否则多设备场景下只会得到一句「无法转发」，无从排查。
     *
     * @param {object} options - 原始 GenerateOptions。
     * @returns {AsyncGenerator<object>} 远端的 chunk。
     */
    async function* relayViaAnyPeer(options) {
        if (!mesh) {
            const e = new Error('mesh 未启用（身份初始化失败），无法转发模型调用。');
            e.code = 'NO_REMOTE_LINK';
            throw e;
        }
        const online = mesh.onlinePeers();
        const withRelay = online.filter((p) => (p.capabilities ?? []).includes(RELAY_ADVERTISED));
        const tried = [];

        // 1) 直连
        for (const p of withRelay) {
            const conn = mesh.connectionTo(p.deviceId);
            if (!conn || conn.closed) { tried.push(p.name + '（连接已断）'); continue; }
            try {
                return yield* relayStream(conn, options, 'phone→peer');
            } catch (error) {
                // 转发失败可能是「对端执行出错」（模型没凭据等），也可能是链路问题。
                // 前者换一台也没用，但后者值得试 —— 所以记下来继续，最后一并报。
                tried.push(p.name + '（' + (error?.message ?? error) + '）');
            }
        }

        // 2) 经中转：找一台宣告了流式中转能力（relay.stream）的设备。
        const via = online.find((p) => (p.capabilities ?? []).includes(TRANSIT_STREAM_METHOD)
            && !withRelay.some((w) => w.deviceId === p.deviceId));
        if (via) {
            const conn = mesh.connectionTo(via.deviceId);
            if (conn && !conn.closed) {
                // 目标没说是谁 —— 由中转方自己挑它连着的、宣告了 llm.relay 的那台。
                // 不能让这里指定 deviceId：调用方（用户/模型）通常不知道目标是谁，
                // 而中转方手里才有「谁在线、谁有模型」这份信息。
                return yield* relayStream(
                    conn,
                    { ...options, __relayPreferRelay: true },
                    'phone→via→peer',
                );
            }
        }

        const e = new Error(
            online.length === 0
                ? '没有已连接的其它设备，无法转发模型调用。请先在「远程联动」里配对。'
                : '无法转发模型调用：' + (tried.length
                    ? '试过的设备都失败了 —— ' + tried.join('；')
                    : '已连接的设备都没有宣告模型转发能力（需要对方的 dsh 上有 llm 服务）。'),
        );
        e.code = 'NO_REMOTE_LINK';
        throw e;
    }

    // GUI 用的 HTTP 路由（挂在已鉴权的 Connection 上）。
    // 手机外壳页面通过本机 dsh 的地址调它们 —— 不用让用户在对话里敲 JSON。
    registerRoutes(ctx, {
        status: async () => { await loadSaved(); return opStatus(); },
        // 开关远程转发。默认 false —— 这是**明确的选择**，不是默认值忘了写。
        llmRelay: async (body) => toggleRelay(body),
        connect: (body) => connect(body ?? {}),
        stop: async () => { state.conn?.close('user requested'); state.conn = null; return { connected: false }; },
        // mesh：设备清单与拓扑。外壳页用它们显示「已配对 / 在线」与切换拓扑。
        devices: async () => {
            if (!mesh) return { self: null, peers: [], online: [] };
            const online = mesh.onlinePeers();
            const onlineIds = new Set(online.map((p) => p.deviceId));
            return {
                self: { deviceId: identity.deviceId, name: mesh.name, topology: mesh.topology },
                peers: (registry?.list() ?? []).map((r) => ({ ...r.toPublic(), online: onlineIds.has(r.deviceId) })),
                online,
            };
        },
        topology: async (body) => {
            if (!mesh) throw new Error('mesh 未启用（身份初始化失败）');
            if (body?.topology) return applyTopology(body.topology);
            return { topology: mesh.topology, dialTargets: mesh.dialTargets().map((r) => r.deviceId) };
        },
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
        // ── mesh：多设备寻址 ────────────────────────────────────────────────
        {
            name: 'link_devices',
            description: '列出所有已配对设备，以及哪些当前在线。每台设备有稳定的 deviceId（公钥指纹），用它配合 link_invoke 指定要操作哪一台。',
            parameters: {},
            async execute() {
                if (!mesh) return { self: null, peers: [], online: [], note: 'mesh 未启用（身份初始化失败）' };
                const online = mesh.onlinePeers();
                const onlineIds = new Set(online.map((p) => p.deviceId));
                return {
                    self: { deviceId: identity.deviceId, name: mesh.name, kind: 'mobile', topology: mesh.topology },
                    // 已配对但离线的也要列 —— 用户需要知道「这台我配过，只是现在不在」。
                    peers: (registry?.list() ?? []).map((r) => ({ ...r.toPublic(), online: onlineIds.has(r.deviceId) })),
                    online,
                };
            },
        },
        {
            name: 'link_invoke',
            description: '在**指定设备**上调用一个方法。device 传 deviceId（link_devices 能看到），或用 "self" 之外的名字匹配。用于 mesh 里同时连着多台时指定目标。',
            parameters: {
                device: { type: 'string', required: true, description: '目标 deviceId（或设备名）。' },
                method: { type: 'string', required: true, description: '要调用的方法，如 mobile.status / computer.status。' },
                args: { type: 'object', additionalProperties: true, properties: {}, description: '方法参数。' },
            },
            required: ['device', 'method'],
            async execute(args) {
                if (!mesh) throw new Error('mesh 未启用（身份初始化失败）');
                const method = String(args.method);
                // 先试直连；连不上再走中转（见 invokeWithRelay）。
                return invokeWithRelay(args.device, method, args.args ?? {});
            },
        },
        {
            name: 'link_topology',
            description: '查看或切换连接拓扑。star（默认）= 一台 hub 收多个 client，client 之间不直连；mesh = 每台都有可达地址时任意两台互连（需要 overlay 虚拟网卡）。',
            parameters: { topology: { type: 'string', description: '要切到的拓扑：star 或 mesh。省略则只查询。' } },
            async execute(args) {
                if (!mesh) throw new Error('mesh 未启用（身份初始化失败）');
                // 切换走 applyTopology：它同时把自动连接驱动起停，否则切了也不会互连。
                const r = args.topology
                    ? await applyTopology(args.topology)
                    : { topology: mesh.topology, dialTargets: mesh.dialTargets().map((x) => x.deviceId) };
                return {
                    ...r,
                    self: identity.deviceId,
                    note: mesh.topology === TOPOLOGY.mesh
                        ? '每台设备都会主动连已知设备；两端按 deviceId 字典序仲裁，不会重复建连。'
                        : '星型：只有 hub 监听，各设备拨入。设备之间不直连。',
                };
            },
        },
        {
            name: 'link_connect_device',
            description: '主动连接一台**已配对**的设备（用 deviceId）。mesh 模式下会按字典序仲裁：不该我拨时返回 null，等对方连进来。',
            parameters: {
                device: { type: 'string', required: true, description: '目标 deviceId。' },
                force: { type: 'boolean', description: '跳过拨号仲裁，强制主动拨（手动配对时用）。' },
            },
            required: ['device'],
            async execute(args) {
                if (!mesh) throw new Error('mesh 未启用（身份初始化失败）');
                const conn = await mesh.dial(args.device, {
                    force: Boolean(args.force),
                    onConnection: (c) => registerMobileMethods(c),
                });
                if (!conn) return { connected: false, reason: '按拨号仲裁不该由本端发起，等对方连进来' };
                return { connected: true, device: args.device, encrypted: Boolean(conn.sessionKey) };
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
            // mesh 拓扑下先起自动连接：它负责**监听**入站（手机在 overlay 下也有
            // 可达地址，别人能连进来）并周期性拨 dialTargets。star 拓扑下手机仍然
            // 只做拨号方 —— 不监听，避免平白开一个入站端口。
            if (mesh && mesh.topology === 'mesh') {
                const started = await mesh.startAutoConnect({
                    intervalMs: 5000,
                    onConnection: (c) => registerMobileMethods(c),
                });
                log('mesh 自动连接已启动（监听=' + started.listening +
                    (started.port ? ' 端口=' + started.port : '') + '）');
            }
            if (state.saved.host && state.saved.token) {
                await connect({});
                log('已用保存的令牌自动重连到 ' + state.saved.host + ':' + state.saved.port);
            }
        } catch (error) {
            log('自动重连未成功（不影响本地使用）：' + (error?.message ?? error));
        }
    })();

    // 插件卸载时收掉定时器与监听 —— 否则热重载/停用后还在后台拨号。
    ctx.effect(() => () => { void mesh?.stopAutoConnect?.(); }, 'dsh-link: mesh auto-connect');
}

export const name = '@dsh-android/link';
export const inject = ['tools', 'connection', 'llm'];

export { apply };
