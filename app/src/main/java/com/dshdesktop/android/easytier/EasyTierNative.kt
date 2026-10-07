package com.dshdesktop.android.easytier

/**
 * EasyTier JNI 声明。
 *
 * ── 签名从哪来 ──────────────────────────────────────────────────────────────
 * 直接照抄官方 `easytier-contrib/easytier-android-jni/kotlin/.../EasyTierJNI.kt`
 * （v2.6.4），**不是猜的**。JNI 方法名由 Rust 侧的 `#[no_mangle] pub extern "C"`
 * 决定，改一个字符就是 UnsatisfiedLinkError，而那个错误只在运行时才炸。
 *
 * 对应的 Rust 侧（easytier-ffi/src/lib.rs）：
 *   set_tun_fd / get_error_msg / free_string / parse_config /
 *   run_network_instance / retain_network_instance / collect_network_infos
 *
 * ── 为什么 runNetworkInstance 收 TOML 而不是命令行参数 ────────────────────────
 * 它吃的是 `TomlConfigLoader::new_from_str(&cfg_str)` —— 也就是说 CLI 上的
 * `--no-tun` / `--port-forward` 等命令行开关，在 JNI 这条路上**不能直接用**，
 * 必须写成 TOML。踩过这个坑：以为「CLI 支持的 TOML 就一定支持」，
 * 实际上字段名与嵌套结构都可能不同。
 *
 * ── ⚠️ 加载失败的表现 ────────────────────────────────────────────────────────
 * `System.loadLibrary` 失败会抛 UnsatisfiedLinkError —— 在**类初始化**时发生，
 * 也就是第一次访问这个 object 就炸。如果 EasyTier 没启用（用户没开组网），
 * 任何碰这个类的代码都会连带崩掉。所以：
 *   · 加载放在 [EasyTierOverlay] 里显式调用并捕获，不放在 object 的 init；
 *   · 其余代码只在「已启用」时才引用本类。
 */
object EasyTierNative {

    /**
     * 加载 libeasytier_android_jni.so。
     *
     * 拆出独立方法（而不是 `init { System.loadLibrary(...) }`）是为了让
     * 「这个功能没启用」与「这个 APK 缺库」成为**可区分**的两种错误 ——
     * 前者正常，后者是打包出了问题。合并成 init 的话两者都是同一个
     * UnsatisfiedLinkError，分不开。
     *
     * @throws UnsatisfiedLinkError 库里没有这个 .so（APK 打包漏了 jniLibs）。
     */
    @JvmStatic
    fun load() {
        System.loadLibrary("easytier_android_jni")
    }

    /** 库是否已加载成功。 */
    @Volatile
    @JvmStatic
    var loaded: Boolean = false
        private set

    /**
     * 加载并标记成功。**只有** [load] 成功后调用。
     *
     * 重复调用是安全的 —— .so 由系统缓存，重复 loadLibrary 不会重复 dlopen。
     */
    @JvmStatic
    fun loadOnce() {
        if (loaded) return
        load()
        loaded = true
    }

    /**
     * 解析配置字符串（TOML）。**仅用于校验**，不启动实例。
     *
     * 组装完配置后先调它，配置写错时能立刻拿到明确错误，而不是让
     * runNetworkInstance 报一个语焉不详的「failed to start instance」。
     *
     * @param config TOML 配置。
     * @return 0 成功，-1 失败（错误信息取 [getLastError]）。
     */
    @JvmStatic
    external fun parseConfig(config: String): Int

    /**
     * 启动网络实例。
     *
     * @param config TOML 配置。
     * @return 0 成功，-1 失败（错误信息取 [getLastError]）。
     */
    @JvmStatic
    external fun runNetworkInstance(config: String): Int

    /**
     * 保留指定实例，停止其余全部。传 null/空数组 = 停止所有。
     *
     * @param instanceNames 要保留的实例名。
     * @return 0 成功，-1 失败。
     */
    @JvmStatic
    external fun retainNetworkInstance(instanceNames: Array<String>?): Int

    /**
     * 取所有运行中实例的信息（JSON）。
     *
     * @param maxLength 最多返回多少条。
     * @return JSON 字符串；无实例时为 null。
     */
    @JvmStatic
    external fun collectNetworkInfos(maxLength: Int): String?

    /** 取出最后一次失败的错误信息；没有则为 null。 */
    @JvmStatic
    external fun getLastError(): String?

    /** 停止全部实例（便利方法）。 */
    @JvmStatic
    fun stopAll(): Int = retainNetworkInstance(null)

    /** 只保留指定实例（便利方法）。 */
    @JvmStatic
    fun retainOnly(instanceName: String): Int = retainNetworkInstance(arrayOf(instanceName))
}