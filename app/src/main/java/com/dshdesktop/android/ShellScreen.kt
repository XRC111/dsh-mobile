package com.dshdesktop.android

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Scaffold
import top.yukonga.miuix.kmp.basic.SmallTitle
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.basic.TopAppBar
import top.yukonga.miuix.kmp.theme.MiuixTheme

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
)

/** 外壳页的回调集合（用 lambda 而不是传 Activity，界面层不认识 Activity）。 */
data class ShellActions(
    val onEnter: () -> Unit,
    val onPickWorkspace: () -> Unit,
    val onToggleMobileUse: () -> Unit,
    val onPickPermissionMode: () -> Unit,
    val onToggleMobileUseInput: () -> Unit,
    val onRestart: () -> Unit,
    val onShowLogs: () -> Unit,
    /** 发起配对（弹出输入 host/port/code 的对话框）。 */
    val onLinkConnect: () -> Unit,
    val onLinkDisconnect: () -> Unit,
)

/**
 * 外壳页：引擎状态 + 设置入口 + 「进入 DSH」。
 *
 * 用 MiuiX 写 —— 这是小米的 MIUI 设计语言（Compose Multiplatform 实现），
 * 在小米机型上观感与系统设置一致。
 *
 * 设计上刻意**不自动打开 dsh 的 Web UI**：那是引擎的界面，不是这个应用的主页。
 * 用户先看到这页（状态、工作区、mobile_use 都在这管），要用了再进去。
 */
@Composable
fun ShellScreen(state: ShellState, actions: ShellActions) {
    MiuixTheme {
        Scaffold(
            topBar = { TopAppBar(title = "DSH") },
        ) { padding ->
            Column(
                Modifier
                    .padding(padding)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
            ) {
                // ── 引擎状态 ─────────────────────────────────────────────
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

                // ── 进入 DSH ─────────────────────────────────────────────
                Button(
                    onClick = actions.onEnter,
                    enabled = state.canEnter,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Text(if (state.canEnter) "进入 DSH" else "引擎未就绪")
                }

                SmallTitle("设置")
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                ) {
                    SettingRow(
                        label = "工作区",
                        value = if (state.workspaceNeedsPermission) {
                            state.workspacePath + "\n需授予「所有文件访问权」"
                        } else {
                            state.workspacePath
                        },
                        actionLabel = "选择",
                        onAction = actions.onPickWorkspace,
                    )
                    SettingRow(
                        label = "mobile_use",
                        value = if (state.mobileUseEnabled) "已开启" else "未开启 —— 需要无障碍权限",
                        actionLabel = "设置",
                        onAction = actions.onToggleMobileUse,
                    )
                }

                SmallTitle("dsh 设置")
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                ) {
                    SettingRow(
                        label = "权限模式",
                        value = state.permissionMode.label + "\n" + state.permissionMode.description,
                        actionLabel = "更改",
                        onAction = actions.onPickPermissionMode,
                    )
                    SettingRow(
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
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                ) {
                    SettingRow(
                        label = "桌面联动",
                        value = when {
                            state.link.error != null -> state.link.error
                            state.link.connected ->
                                "已连接：" + state.link.desktopName +
                                    "\n可用 desktop_* 工具操作桌面"
                            state.link.savedHost.isNotEmpty() ->
                                "未连接 —— 上次连过 " + state.link.savedHost +
                                    if (state.link.hasToken) "（可直接重连）" else "（需要配对码）"
                            else -> "未连接 —— 需要桌面上的配对码"
                        },
                        actionLabel = if (state.link.connected) "断开" else "配对",
                        onAction = if (state.link.connected) actions.onLinkDisconnect else actions.onLinkConnect,
                    )
                }

                SmallTitle("诊断")
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp),
                ) {
                    SettingRow(
                        label = "日志",
                        value = "dsh.log / node-stderr.log / mobile-use.log",
                        actionLabel = "查看",
                        onAction = actions.onShowLogs,
                    )
                    SettingRow(
                        label = "版本",
                        value = state.version,
                        actionLabel = null,
                        onAction = null,
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
        }
    }
}

/**
 * 一行设置项：左标签 + 值，右侧可选操作按钮。
 *
 * 值可能带换行（比如工作区缺权限时的第二行说明），所以用 Column 而不是 Row 撑值，
 * 只有按钮那侧对齐到顶部。
 */
@Composable
private fun SettingRow(
    label: String,
    value: String,
    actionLabel: String?,
    onAction: (() -> Unit)?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(text = label, fontSize = 16.sp)
            Text(
                text = value,
                fontSize = 13.sp,
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        if (actionLabel != null && onAction != null) {
            Button(onClick = onAction) { Text(actionLabel) }
        }
    }
}
