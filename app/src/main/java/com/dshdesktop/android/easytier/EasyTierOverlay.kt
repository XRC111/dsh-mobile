package com.dshdesktop.android.easytier

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 内嵌 EasyTier 的**客户端侧**封装：在 dsh 进程里跑一个组网实例。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 手机与桌面异地时，两边不在同一网络，直连的地址填什么都不好使（桌面的家用宽带
 * 大概率在 NAT 后面）。EasyTier 负责建 overlay 隧道。
 *
 * 之前桌面上要用户自己装 EasyTier（还要自己填 --port-forward），手机这边什么
 * 都没有。现在两个库的 .so 都在 APK 里，这个类就是把它们用起来的地方。
 *
 * ── 关键约束：无 TUN 模式 ────────────────────────────────────────────────────
 * 本方案**不创建 TUN 设备、不改系统路由表**，因此：
 *   · 不需要 VPN 权限（`android.permission.BIND_VPN_SERVICE` 完全不碰）；
 *   · 不需要前台服务；
 *   · 不影响手机其它 App 的网络。
 * 手机本机在 127.0.0.1 上监听一个端口，把桌面的联动端口（默认 45731）通过
 * overlay 映射进来，然后让 link 插件连 127.0.0.1:那个端口。
 *
 * 为什么不能反过来（手机主动访问桌面）：无 TUN 模式下本机没有虚拟网卡，
 * 发不出「访问虚拟网内其它节点」的包 —— 这是 TUN 的作用。只能由**本机监听、
 * 把远端端口拉过来**（入方向）。官方文档「无 TUN 模式」一节写的正是这件事。
 *
 * ── TOML 字段来自源码，不是猜的 ──────────────────────────────────────────────
 * `runNetworkInstance` 收的是 TOML 字符串，走 `TomlConfigLoader`，**不吃 CLI
 * 参数**。所以 `--no-tun` / `--port-forward` 在这条路上不能直接用。
 * 字段依据 easytier-core v2.6.4：
 *   · config/gateway.rs → `struct PortForwardConfig { bind_addr, dst_addr, proto }`
 *     （proto 是字符串 "tcp" / "udp"，不是枚举数字）
 *   · config/gateway.rs → `ProxyRuntimeConfig { no_tun: bool }`
 *   · config/toml.rs    → `struct NetworkIdentity { network_name, network_secret }`
 */
object EasyTierOverlay {

    private const val TAG = "EasyTier"
    /** 实例名。EasyTier 用它区分同一进程里的多个实例。 */
    private const val INSTANCE = "dsh-phone"

    /** 配置落盘位置（filesDir，不进 assets —— 里面有网络密钥）。 */
    private fun configFile(context: Context): File =
        File(context.filesDir, "easytier/config.toml")

    private val running = AtomicBoolean(false)

    /** 实例是否在跑。 */
    fun isRunning(): Boolean = running.get()

    /**
     * 组装 TOML 配置。
     *
     * @param networkName 网络名（两端必须一致）。
     * @param networkSecret 网络密钥（两端必须一致）。
     * @param peerUri 对端地址，形如 `tcp://1.2.3.4:11010`。留空则不连任何人
     *        （此时本机只作为等待方，靠对端来连）。
     * @param bindAddr 本机监听地址，形如 `127.0.0.1:45731`。
     *        **必须绑 127.0.0.1**：绑 0.0.0.0 会把转发端口暴露给同网段任何人，
     *        等于把联动通道敞开。link 插件本来就只连 127.0.0.1。
     * @param dstAddr 目标（桌面的虚拟网 IP + 联动端口），形如 `10.144.0.2:45731`。
     * @return TOML 文本。
     */
    fun buildToml(
        networkName: String,
        networkSecret: String,
        peerUri: String,
        bindAddr: String,
        dstAddr: String,
    ): String = buildString {
        appendLine("# 由 DSH Android 外壳生成 —— 在「远程联动」里改，不要手编。")
        appendLine("instance_name = \"$INSTANCE\"")
        appendLine("hostname = \"phone\"")
        // 固定虚拟 IP：端口转发规则里的 dst_addr 指向对端虚拟 IP，
        // 若让它随机分配，每次重启对端 IP 就变了，这里的规则随之失效。
        appendLine("ipv4 = \"10.144.0.3/24\"")
        appendLine()
        appendLine("[network_identity]")
        appendLine("network_name = \"$networkName\"")
        appendLine("network_secret = \"$networkSecret\"")
        appendLine()
        // flags：no_tun 是这个方案成立的前提（见类注释）。
        appendLine("[flags]")
        appendLine("no_tun = true")
        appendLine("disable_p2p = false")
        appendLine()
        if (peerUri.isNotBlank()) {
            appendLine("[[peer]]")
            appendLine("uri = \"$peerUri\"")
            appendLine()
        }
        // port_forwards 的字段名与类型见 gateway.rs 的 PortForwardConfig。
        appendLine("[[port_forwards]]")
        appendLine("proto = \"tcp\"")
        appendLine("bind_addr = \"$bindAddr\"")
        appendLine("dst_addr = \"$dstAddr\"")
    }

    /**
     * 启动组网。
     *
     * 顺序刻意是**先校验再启动**：先 `parseConfig` 过一遍，配置写错时能立刻拿到
     * 明确错误（哪个字段不认），而不是让 `runNetworkInstance` 报一句
     * 「failed to start instance」—— 那句话完全指不到配置的行。
     *
     * @throws IllegalStateException 配置非法或实例启动失败（消息含原因）。
     */
    @Throws(IllegalStateException::class)
    fun start(
        context: Context,
        networkName: String,
        networkSecret: String,
        peerUri: String,
        bindPort: Int,
        dstAddr: String,
    ) {
        EasyTierNative.loadOnce()
        if (running.get()) stop()

        val bindAddr = "127.0.0.1:$bindPort"
        val toml = buildToml(networkName, networkSecret, peerUri, bindAddr, dstAddr)

        // 配置里有网络密钥，落盘权限收窄到仅自己可读。
        val f = configFile(context)
        f.parentFile?.mkdirs()
        runCatching { f.setReadable(false, false); f.setReadable(true, true) }
        f.writeText(toml)

        // 先校验：runNetworkInstance 失败时的信息太笼统。
        if (EasyTierNative.parseConfig(toml) != 0) {
            val err = EasyTierNative.getLastError() ?: "未知错误"
            throw IllegalStateException("EasyTier 配置不合法：$err\n\n配置：\n$toml")
        }
        if (EasyTierNative.runNetworkInstance(toml) != 0) {
            val err = EasyTierNative.getLastError() ?: "未知错误"
            throw IllegalStateException("EasyTier 启动失败：$err")
        }
        running.set(true)
        Log.i(TAG, "EasyTier 已启动，转发 127.0.0.1:$bindPort → $dstAddr")
    }

    /** 停止组网。已停止时是空操作 —— 停止别人已经停的东西不该报错。 */
    fun stop() {
        if (!running.getAndSet(false)) return
        runCatching {
            EasyTierNative.loadOnce()
            EasyTierNative.stopAll()
        }.onFailure { Log.w(TAG, "停止 EasyTier 失败", it) }
        Log.i(TAG, "EasyTier 已停止")
    }

    /**
     * 当前状态，供界面显示。
     *
     * @return 状态 JSON；库没起来时 [running] 为 false 且 [runningInfo] 为空。
     */
    fun status(): JSONObject = JSONObject().apply {
        put("running", running.get())
        put("instance", INSTANCE)
        if (!EasyTierNative.loaded) {
            put("runningInfo", "")
            return@apply
        }
        val raw = runCatching { EasyTierNative.collectNetworkInfos(16) }.getOrNull()
        put("runningInfo", raw ?: "")
        put("peers", parsePeers(raw))
    }

    /**
     * 从 collectNetworkInfos 的 JSON 里抽出对端列表。
     *
     * 官方 EasyTierManager 轮询这个接口拿 virtual_ipv4 与 proxy_cidrs；这里
     * 只需要知道「连上了几个、对方虚拟 IP 是多少」，够界面显示即可。
     *
     * 结构可能随版本变（它不是稳定 API），所以**任何解析失败都退化成空列表** ——
     * 界面少显示几个对端，远好过因为格式变了而抛异常把设置页搞崩。
     */
    private fun parsePeers(raw: String?): JSONArray {
        val out = JSONArray()
        if (raw.isNullOrBlank()) return out
        runCatching {
            val root = JSONObject(raw)
            val map = root.optJSONObject("map") ?: return@runCatching
            for (key in map.keys()) {
                val info = map.optJSONObject(key) ?: continue
                if (!info.optBoolean("running", false)) continue
                val routes = info.optJSONArray("routes")
                val peerIpv4 = routes?.optJSONObject(0)
                    ?.optJSONObject("peer_id")?.optString("ipv4").orEmpty()
                out.put(JSONObject().apply {
                    put("name", key)
                    put("ipv4", peerIpv4)
                })
            }
        }.onFailure { Log.w(TAG, "解析运行信息失败（界面将少显示对端）", it) }
        return out
    }

    /** 当前配置内容（不含密钥，供诊断页显示）。 */
    fun configForDiagnostics(context: Context): String {
        val f = configFile(context)
        if (!f.exists()) return "（尚未配置）"
        return runCatching {
            f.readText().lines()
                .filterNot { it.contains("network_secret") }
                .joinToString("\n")
        }.getOrElse { "（读取失败：${it.message}）" }
    }
}