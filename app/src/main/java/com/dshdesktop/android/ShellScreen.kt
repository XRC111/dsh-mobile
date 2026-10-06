package com.dshdesktop.android

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonColors
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.SmallTitle
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TopAppBar
import top.yukonga.miuix.kmp.theme.MiuixTheme

/**
 * 主操作按钮的配色（与对话框里的「确定 / 连接」保持一致）。
 *
 * v0.7.2 的 ButtonColors 只有 color / disabledColor 两个字段 —— 已核对 Button.kt。
 */
@Composable
private fun primaryActionColors(): ButtonColors = ButtonColors(
    color = MiuixTheme.colorScheme.primary,
    disabledColor = MiuixTheme.colorScheme.disabledPrimaryButton,
)

/**
 * 外壳页面的全部可变状态。
 *
 * 刻意做成一个不可变数据类：Compose 靠它判断要不要重组，而 MainActivity 那边
 * 只负责把 NodeState / 设置读出来填进去 —— 界面本身不碰任何 Android API。
 */
data class ShellState(
    val phase: NodeState.Phase,
    val statusLine: String,
    val workspacePath: String,
    val workspaceNeedsPermission: Boolean,
    val mobileUseEnabled: Boolean,
    val permissionMode: DshSettings.PermissionMode,
    val mobileUseInput: Boolean,
    val version: String,
    val canEnter: Boolean,
    val error: String?,
    /** 远程联动状态（未连接时 connected=false）。 */
    val link: LinkSnapshot,
)

/**
 * mesh（多设备）的界面快照。
 *
 * 与 LinkSnapshot 分开：那一个是「和桌面的这一条连接」，这一个是「本机身份 + 认识哪些
 * 设备 + 哪些在线」。两者来源不同（前者随每次 connect 变，后者是注册表的持久状态），
 * 混在一起会出现「断了但设备列表还在」这类半新半旧的显示。
 */
data class MeshSnapshot(
    /** 本机 deviceId（16 位十六进制，公钥指纹）。 */
    val selfId: String = "",
    /** 本机设备名。 */
    val selfName: String = "",
    /** 当前拓扑：star / mesh。 */
    val topology: String = "star",
    /** 已配对设备数（含离线）。 */
    val paired: Int = 0,
    /** 在线设备（名字 + id）。 */
    val online: List<Pair<String, String>> = emptyList(),
) {
    val topologyLabel: String get() = if (topology == "mesh") "全互联" else "星型"
}

/**
 * 远程联动的界面快照。
 *
 * 单独一个 data class 而不是散在一堆字段里：这些值要么全来自同一次路由调用，
 * 要么全没有，散着放很容易出现「一半新一半旧」的显示。
 */
data class LinkSnapshot(
    val connected: Boolean = false,
    val desktopName: String = "",
    val savedHost: String = "",
    val savedPort: Int = 0,
    val hasToken: Boolean = false,
    val error: String? = null,
    /** 连接方式：direct（直连）或 forward（端口转发）。 */
    val mode: String = "direct",
    /** 远程凭据转发是否已开启（默认 false）。 */
    val llmRelayEnabled: Boolean = false,
    /** 对端（桌面）是否宣告了转发能力。 */
    val llmRelayAvailable: Boolean = false,
    /** mesh：本机身份与设备清单。 */
    val mesh: MeshSnapshot = MeshSnapshot(),
) {
    /** 中文名，直接显示在卡片上。 */
    val modeLabel: String get() = if (mode == "forward") "端口转发" else "直连"
}

/**
 * 外壳页的回调集合（用 lambda 而不是传 Activity，界面层不认识 Activity）。
 *
 * ⚠️ 这里的回调**只做动作**，不弹任何框：该显示哪个框由 ShellScreen 的 dialog 参数决定，
 *    由 [ShellDialogHost] 渲染。这样「点一下」与「弹什么」分开，界面层不需要认识
 *    AlertDialog，也不会出现「弹了两个框」或「框关了状态还在」这类不一致。
 */
data class ShellActions(
    val onEnter: () -> Unit,
    val onPickWorkspace: () -> Unit,
    val onToggleMobileUse: () -> Unit,
    val onPickPermissionMode: (DshSettings.PermissionMode) -> Unit,
    val onToggleMobileUseInput: () -> Unit,
    val onRestart: () -> Unit,
    val onShowLogs: () -> Unit,
    /** 发起配对（参数已由对话框收集好）。 */
    val onLinkConnect: (host: String, port: Int, code: String, mode: String) -> Unit,
    /** 打开配对对话框（MainActivity 负责把上次填的地址塞进 dialog 状态）。 */
    val onPickLinkConnect: () -> Unit,
    val onLinkDisconnect: () -> Unit,
    /** 切换远程凭据转发。 */
    val onToggleLlmRelay: (Boolean) -> Unit,
    /** 当前权限模式（对话框需要它做初值）。 */
    val currentPermissionMode: () -> DshSettings.PermissionMode,
    /** 跳系统无障碍设置页。 */
    val onOpenMobileUseSettings: () -> Unit,
    /** 跳「所有文件访问权」设置页。 */
    val onRequestAllFilesAccess: () -> Unit,
    /** 放弃共享存储、把工作区留在应用私有目录。 */
    val onStayPrivateWorkspace: () -> Unit,
    /** 关闭当前对话框。 */
    val onDismissDialog: () -> Unit,
    /** 关闭轻提示。 */
    val onDismissBanner: () -> Unit,
    /** 切换 mesh 拓扑（star / mesh）。 */
    val onSetTopology: (String) -> Unit,
    /** 打开开源许可页（LGPL 合规要求：声明与替换机制必须对用户可达）。 */
    val onShowLicenses: () -> Unit,
)

/**
 * 外壳页：引擎状态 + 设置入口 + 「进入 DSH」。
 *
 * 用 MiuiX 写 —— 这是小米的 MIUI 设计语言（Compose Multiplatform 实现），
 * 在小米机型上观感与系统设置一致。
 *
 * 设计上刻意**不自动打开 dsh 的 Web UI**：那是引擎的界面，不是这个应用的主页。
 * 用户先看到这页（状态、工作区、mobile_use 都在这管），要用了再进去。
 *
 * ⚠️ `dialog` / `banner` 作为**参数**传入而不是塞进 [ShellState]：它们会被
 *    调用方随时改动（点「取消」就是置 null），而 ShellState 是 pushShellState()
 *    抓的快照 —— 走快照的话那个改动不会触发重组，表现是**对话框关不掉**。
 *
 * @param state 页面状态快照。
 * @param dialog 当前该显示的对话框；null 表示没有。
 * @param banner 轻提示文字；null 表示不显示。
 * @param actions 动作回调。
 */
@Composable
fun ShellScreen(
    state: ShellState,
    dialog: ShellDialog?,
    banner: String?,
    actions: ShellActions,
) {
    MiuixTheme {
        // ⚠️ SuperDialog 必须在 Scaffold 内部 —— 它依赖 Scaffold 提供的
        //    MiuixPopupHost，放到外面弹出内容不会渲染（v0.7.2 的硬约束，见组件文档）。
        Scaffold(
            topBar = { TopAppBar(title = "DSH") },
        ) { padding ->
            Box(Modifier.fillMaxSize()) {
                Column(
                    Modifier
                        .padding(padding)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState()),
                ) {
                    // ── 引擎状态 ─────────────────────────────────────────
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        Text(
                            text = state.statusLine,
                            fontSize = 15.sp,
                            modifier = Modifier.padding(16.dp),
                        )
                        if (state.error != null) {
                            Text(
                                text = state.error,
                                fontSize = 13.sp,
                                color = MiuixTheme.colorScheme.error,
                                modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                            )
                        }
                    }

                    // ── 进入 DSH ─────────────────────────────────────────
                    Button(
                        onClick = actions.onEnter,
                        enabled = state.canEnter,
                        colors = primaryActionColors(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        Text(if (state.canEnter) "进入 DSH" else "引擎未就绪")
                    }

                    SmallTitle("设置")
                    ShellCard {
                        ShellInfoRow(
                            label = "工作区",
                            value = if (state.workspaceNeedsPermission) {
                                state.workspacePath + "\n需授予「所有文件访问权」"
                            } else {
                                state.workspacePath
                            },
                            actionLabel = "选择",
                            onAction = actions.onPickWorkspace,
                        )
                        ShellInfoRow(
                            label = "mobile_use",
                            value = if (state.mobileUseEnabled) "已开启" else "未开启 —— 需要无障碍权限",
                            actionLabel = "设置",
                            onAction = actions.onToggleMobileUse,
                        )
                    }

                    SmallTitle("dsh 设置")
                    ShellCard {
                        ShellInfoRow(
                            label = "权限模式",
                            value = state.permissionMode.label + "\n" + state.permissionMode.description,
                            actionLabel = "更改",
                            onAction = { actions.onPickPermissionMode(state.permissionMode) },
                        )
                        ShellInfoRow(
                            label = "mobile_use 允许输入",
                            value = if (state.mobileUseInput) {
                                "已开启 —— 模型可点击、滑动、输入"
                            } else {
                                "已关闭 —— 只允许截屏与读取界面元素"
                            },
                            actionLabel = if (state.mobileUseInput) "关闭" else "开启",
                            onAction = actions.onToggleMobileUseInput,
                        )
                    }

                    SmallTitle("远程联动")
                    ShellCard {
                        ShellInfoRow(
                            label = "桌面联动",
                            value = when {
                                state.link.error != null -> state.link.error
                                state.link.connected ->
                                    "已连接：" + state.link.desktopName +
                                        "\n" + state.link.modeLabel +
                                        " · 可用 desktop_* 工具操作桌面"
                                state.link.savedHost.isNotEmpty() ->
                                    "未连接 —— 上次 " + state.link.modeLabel + " 连过 " + state.link.savedHost +
                                        if (state.link.hasToken) "（可直接重连）" else "（需要配对码）"
                                else -> "未连接 —— 需要桌面上的配对码"
                            },
                            actionLabel = if (state.link.connected) "断开" else "配对",
                            onAction = if (state.link.connected) actions.onLinkDisconnect else actions.onPickLinkConnect,
                        )
                        ShellInfoRow(
                            label = "远程转发",
                            value = when {
                                !state.link.llmRelayAvailable -> "桌面未宣告该能力（不可用）"
                                state.link.llmRelayEnabled -> "已开启 —— 对话内容会发到桌面执行"
                                else -> "已关闭 —— 需显式开启"
                            },
                            actionLabel = if (state.link.llmRelayEnabled) "关闭" else "开启",
                            onAction = if (state.link.llmRelayAvailable) {
                                { actions.onToggleLlmRelay(!state.link.llmRelayEnabled) }
                            } else null,
                        )
                    }

                    // ── 多设备（mesh）────────────────────────────────────
                    // 只在拿到身份后显示：身份初始化失败时这一节没有意义，
                    // 显示一排空值只会让人以为坏了。
                    if (state.link.mesh.selfId.isNotEmpty()) {
                        SmallTitle("多设备")
                        ShellCard {
                            ShellInfoRow(
                                label = "本机",
                                value = state.link.mesh.selfName + "\n" + state.link.mesh.selfId,
                            )
                            ShellInfoRow(
                                label = "连接拓扑",
                                value = state.link.mesh.topologyLabel + when (state.link.mesh.topology) {
                                    "mesh" -> "\n每台设备都会主动连已知设备（需要 overlay 虚拟网卡）"
                                    else -> "\n由桌面接收各设备接入；设备之间不直连"
                                },
                                actionLabel = if (state.link.mesh.topology == "mesh") "改星型" else "改全互联",
                                onAction = {
                                    actions.onSetTopology(if (state.link.mesh.topology == "mesh") "star" else "mesh")
                                },
                            )
                            ShellInfoRow(
                                label = "已配对 / 在线",
                                value = state.link.mesh.paired.toString() + " 台已配对 · " +
                                    state.link.mesh.online.size + " 台在线" +
                                    if (state.link.mesh.online.isEmpty()) {
                                        ""
                                    } else {
                                        "\n" + state.link.mesh.online.joinToString("、") { it.first }
                                    },
                            )
                        }
                    }

                    SmallTitle("诊断")
                    ShellCard {
                        ShellInfoRow(
                            label = "日志",
                            value = "dsh.log / node-stderr.log / mobile-use.log",
                            actionLabel = "查看",
                            onAction = actions.onShowLogs,
                        )
                        ShellInfoRow(
                            label = "版本",
                            value = state.version,
                        )
                        ShellInfoRow(
                            label = "开源许可",
                            value = "本应用含 EasyTier（LGPL-3.0）等第三方组件",
                            actionLabel = "查看",
                            onAction = actions.onShowLicenses,
                        )
                    }

                    if (state.phase == NodeState.Phase.FAILED) {
                        Button(
                            onClick = actions.onRestart,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 16.dp),
                        ) {
                            Text("重启应用")
                        }
                    }

                    Spacer(Modifier.height(32.dp))
                }

                // 轻提示浮在底部（替代 Toast —— 那个是系统绘制的，与这里的设计语言不一致）
                Box(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 24.dp),
                ) {
                    ShellBanner(message = banner, onDismiss = actions.onDismissBanner)
                }
            }

            // 所有对话框的唯一渲染点
            ShellDialogHost(
                dialog = dialog,
                link = state.link,
                actions = actions,
                onDismiss = actions.onDismissDialog,
            )
        }
    }
}

