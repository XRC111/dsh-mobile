package com.dshdesktop.android.easytier

/**
 * 内嵌组网的固定参数（网络名与密钥）。
 *
 * ── 为什么先写死 ────────────────────────────────────────────────────────────
 * 两端必须用**同一个**网络名与密钥，否则隧道建不起来。而用户第一次用时还不知道
 * 该填什么 —— 让他先去桌面查一遍再回来填，等于把整个功能挡在门外。
 *
 * 所以先给一组默认值：桌面侧用同一组就能直接通。将来要做成「用户自定」时，
 * 把这里换成从设置读取即可，调用方（[EasyTierOverlay.start]）不需要改。
 *
 * ⚠️ 换成用户自定后，**网络密钥不能明文落在 UI 能看到的地方**，且需要考虑
 *    多设备场景下「哪台设备用哪个网络」的归属问题。
 */
object OverlayConfig {
    /** 网络名。 */
    const val NETWORK_NAME = "dsh"

    /**
     * 网络密钥。
     *
     * 这是**组网网络的通行口令** —— 拿到它的人就能加入这个网络。
     * 因此它属于「需要保护」的数据：落盘时权限收窄（见 [EasyTierOverlay.start]），
     * 诊断页显示时过滤掉（见 [EasyTierOverlay.configForDiagnostics]）。
     *
     * 它**不是**模型 API 凭据 —— 模型转发走的是 link 通道，两者完全独立，
     * 泄露这个不等于泄露 API Key。
     */
    const val NETWORK_SECRET = "dsh-link-overlay"
}