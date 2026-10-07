package com.dshdesktop.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import top.yukonga.miuix.kmp.basic.Button
import top.yukonga.miuix.kmp.basic.ButtonColors
import top.yukonga.miuix.kmp.basic.Card
import top.yukonga.miuix.kmp.basic.Surface
import top.yukonga.miuix.kmp.basic.Text
import top.yukonga.miuix.kmp.extra.SpinnerEntry
import top.yukonga.miuix.kmp.extra.SuperDialog
import top.yukonga.miuix.kmp.extra.SuperSpinner
import top.yukonga.miuix.kmp.theme.MiuixTheme

/**
 * 主操作按钮的配色（MIUI 里「确定 / 连接」这类按钮用主题色）。
 *
 * v0.7.2 的 ButtonColors 只有两个字段（color / disabledColor），不是 Material 那种
 * containerColor/contentColor 一对 —— 已核对 Button.kt 的类定义，别照 Material 的习惯写。
 */
@Composable
private fun primaryButtonColors(): ButtonColors = ButtonColors(
    color = MiuixTheme.colorScheme.primary,
    disabledColor = MiuixTheme.colorScheme.disabledPrimaryButton,
)

/**
 * 外壳页的对话框模型。
 *
 * ── 为什么要做成数据而不是直接弹 ──────────────────────────────────────────────
 * 原先这些确认框全是 `android.app.AlertDialog`（原生 Material 观感），而外壳页本身是
 * MiuiX 写的 —— 同一个应用里两套视觉语言，点「配对」弹出来的框和页面完全不是一回事。
 *
 * 现在把它们统一成**声明式**：MainActivity 只负责把「该显示哪个框」写进状态，
 * 由 ShellScreen 里的 [ShellDialogHost] 用 MiuiX 渲染。这样：
 *   · 观感与页面一致（同一个主题、同一套圆角与配色）；
 *   · 对话框不再是「命令式弹一个再手动关」，而是状态的函数，不会漏关也不会重复弹；
 *   · 界面层继续不认识 Activity（与 ShellScreen 的既有约定一致）。
 */
sealed interface ShellDialog {
    /** 日志路径说明。 */
    data object LogPaths : ShellDialog

    /** dsh 权限模式选择（单选列表）。 */
    data object PermissionMode : ShellDialog

    /** 「设置已保存，需重启生效」确认框。 */
    data class ConfirmRestart(val message: String) : ShellDialog

    /** mobile_use 无障碍开关引导。 */
    data class MobileUse(val enabled: Boolean) : ShellDialog

    /** 共享存储需要「所有文件访问权」的引导。 */
    data object AllFilesAccess : ShellDialog

    /** 工作区已选定（提示重启生效）。 */
    data class WorkspaceSet(val path: String) : ShellDialog

    /** 连接桌面：填地址 / 端口 / 配对码，并选连接方式。 */
    data class LinkConnect(
        val host: String,
        val port: Int,
        val mode: String,
    ) : ShellDialog

    /** 开源许可与第三方组件说明（LGPL 合规要求，必须可达）。 */
    data object Licenses : ShellDialog
}

/**
 * 对话框宿主内部的显示状态。
 *
 * ── 为什么不能用 `rememberShow(active)` ─────────────────────────────────────
 * 之前每个分支都写 `rememberShow(true)`：`active` 是**常量 true**，于是
 * `LaunchedEffect(true)` 只在首次组合时跑一次，`show` 永远是 true。
 * 调用方点「取消」时只清了 Activity 的状态，Compose 这边 `show` 没被置 false ——
 * 分支被移除后再次组合时 `remember` 又初始化回 true，表现就是
 * **「对话框关不掉」**（点了消失一瞬间又回来）。
 *
 * 现在改成：一个宿主级的 `show`，关闭时**先**置 false（触发退场动画），
 * 动画走完再清上层状态。这样「能不能关」不再依赖各分支怎么写。
 */
@Composable
private fun rememberDialogShow(dialog: ShellDialog?): MutableState<Boolean> {
    val show = remember { mutableStateOf(false) }
    // 有新框就显示；状态被上层清空（例如从别处 dismiss）就收起。
    LaunchedEffect(dialog) { show.value = dialog != null }
    return show
}

/**
 * 一个 MiuiX 风格的确认框：标题 + 正文 + 若干按钮。
 *
 * 按钮横向排布、右侧为主操作（与 MIUI 的习惯一致）。
 *
 * @param show 是否显示。
 * @param title 标题。
 * @param message 正文（可含换行）。
 * @param confirmText 主按钮文字。
 * @param onConfirm 主按钮回调。
 * @param dismissText 次按钮文字；null 表示只有一个按钮。
 * @param onDismiss 关闭回调（点遮罩 / 返回手势也会走它）。
 */
@Composable
fun ShellConfirmDialog(
    show: MutableState<Boolean>,
    title: String,
    message: String,
    confirmText: String,
    onConfirm: () -> Unit,
    dismissText: String? = null,
    onDismiss: () -> Unit,
) {
    SuperDialog(
        show = show,
        title = title,
        onDismissRequest = onDismiss,
    ) {
        // 正文可能很长（权限说明那几条），给个上限并允许滚动，
        // 否则小屏上按钮会被顶出可视区、点不到。
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 320.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                text = message,
                fontSize = 14.sp,
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            )
        }
        Spacer(Modifier.height(20.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
        ) {
            if (dismissText != null) {
                Button(onClick = onDismiss) { Text(dismissText) }
            }
            Button(
                onClick = onConfirm,
                colors = primaryButtonColors(),
            ) { Text(confirmText) }
        }
    }
}

/**
 * 所有外壳对话框的宿主。放在 `Scaffold` 内部 —— SuperDialog 依赖它提供的
 * `MiuixPopupHost`，不在 Scaffold 里弹出内容不会渲染（v0.7.2 的硬约束）。
 *
 * @param dialog 当前该显示的框；null 表示没有。
 * @param link 联动快照（配对框要拿上次填的地址/端口/方式做初值）。
 * @param actions 各框的动作回调。
 * @param onDismiss 关闭当前框。
 */
@Composable
fun ShellDialogHost(
    dialog: ShellDialog?,
    link: LinkSnapshot,
    actions: ShellActions,
    onDismiss: () -> Unit,
) {
    // 唯一一份 show，所有分支共用。
    //
    // 「先收起、再清上层状态」的顺序是关键：只清状态的话，分支会被立刻移除，
    // 而重新组合时 remember 又初始化成 true —— 那就是「关不掉」的来源。
    val show = rememberDialogShow(dialog)
    val close = {
        show.value = false   // 触发退场
        onDismiss()          // 清上层状态（下一帧 dialog 变 null）
    }

    // dialog 为 null 时不再渲染内容，但上面的 show LaunchedEffect 已经把它收起了。
    if (dialog == null) return

    when (dialog) {
        ShellDialog.LogPaths -> ShellConfirmDialog(
            show = show,
            title = "日志",
            message = "引擎日志：files/dsh.log\n" +
                "Node stderr：files/node-stderr.log\n" +
                "mobile_use 操作：files/mobile-use.log\n" +
                "崩溃：files/crash.log\n\n" +
                "用 adb 取：\nadb shell run-as <包名> cat files/dsh.log",
            confirmText = "知道了",
            onConfirm = close,
            onDismiss = close,
        )

        ShellDialog.PermissionMode -> PermissionModeDialog(show, close, actions)

        is ShellDialog.ConfirmRestart -> ShellConfirmDialog(
            show = show,
            title = "需要重启应用",
            message = dialog.message,
            confirmText = "立即重启",
            onConfirm = { close(); actions.onRestart() },
            dismissText = "稍后",
            onDismiss = close,
        )

        is ShellDialog.MobileUse -> ShellConfirmDialog(
            show = show,
            title = if (dialog.enabled) "关闭 mobile_use" else "开启 mobile_use",
            message = if (dialog.enabled) {
                "请在系统设置里关闭「DSH」的无障碍开关。\n\n关闭后 mobile_use 的全部工具立即失效。"
            } else {
                "mobile_use 需要无障碍权限，系统不允许应用自行开启。\n\n" +
                    "接下来的设置页里找到「DSH」并打开开关。开启后模型就能：\n" +
                    "· 截屏看画面\n· 读取界面元素（精确坐标）\n· 模拟点击 / 滑动 / 输入\n\n" +
                    "也就是说它可以代替你操作这台手机。不需要时请关掉。"
            },
            confirmText = "去设置",
            onConfirm = { close(); actions.onOpenMobileUseSettings() },
            dismissText = "取消",
            onDismiss = close,
        )

        ShellDialog.AllFilesAccess -> ShellConfirmDialog(
            show = show,
            title = "需要「所有文件访问权」",
            message = "要把工作区放在共享存储（如 /sdcard/Documents）必须先授予该权限。\n\n" +
                "这是特殊权限，系统不允许弹窗授予，需要你在接下来的设置页里手动打开开关。\n\n" +
                "不授予也可以继续：工作区会留在应用私有目录内，仅本应用可见。",
            confirmText = "去设置",
            onConfirm = { close(); actions.onRequestAllFilesAccess() },
            dismissText = "留在私有目录",
            onDismiss = { close(); actions.onStayPrivateWorkspace() },
        )

        is ShellDialog.WorkspaceSet -> ShellConfirmDialog(
            show = show,
            title = "工作区已设为",
            message = dialog.path + "\n\n重启应用后生效（当前引擎的 cwd 已经固定）。",
            confirmText = "立即重启",
            onConfirm = { close(); actions.onRestart() },
            dismissText = "稍后",
            onDismiss = close,
        )

        is ShellDialog.LinkConnect -> LinkConnectDialog(dialog, show, close, actions)

        ShellDialog.Licenses -> LicensesDialog(show, close)
    }
}

/**
 * 权限模式选择框。
 *
 * 用 SuperSpinner（MIUI 原生的列表选择样式）而不是自绘单选项：它是这个设计语言里
 * 「从若干项里挑一个」的标准控件，观感与系统设置一致。
 *
 * @param show 宿主持有的显示状态（关闭时要由调用方/宿主置 false）。
 * @param onClose 关闭并清上层状态。
 */
@Composable
private fun PermissionModeDialog(
    show: MutableState<Boolean>,
    onClose: () -> Unit,
    actions: ShellActions,
) {
    val modes = DshSettings.PermissionMode.entries
    val current = modes.indexOf(actions.currentPermissionMode()).coerceAtLeast(0)
    var selected by remember { mutableStateOf(current) }

    SuperDialog(
        show = show,
        title = "dsh 权限模式",
        summary = "选完需要重启应用生效。",
        onDismissRequest = onClose,
    ) {
        SuperSpinner(
            items = modes.map { SpinnerEntry(title = it.label + "（" + it.id + "）", summary = it.description) },
            selectedIndex = selected,
            title = "模式",
            onSelectedIndexChange = { selected = it },
        )
        Spacer(Modifier.height(20.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
        ) {
            Button(onClick = onClose) { Text("取消") }
            Button(
                onClick = { onClose(); actions.onPickPermissionMode(modes[selected]) },
                colors = primaryButtonColors(),
            ) { Text("确定") }
        }
    }
}

/**
 * 连接桌面：地址 / 端口 / 配对码 + 连接方式。
 *
 * 连接方式用 SuperSpinner 而不是两个单选按钮：两种方式填错时的报错都是「连不上」、
 * 原因却完全相反，所以这里把说明直接写进每个选项的 summary 里，用户选的时候就看得到。
 */
/**
 * 第三方组件与开源许可。
 *
 * ── 为什么这个页面必须存在 ───────────────────────────────────────────────────
 * 内嵌 EasyTier 后，APK 里带着 LGPL-3.0 的动态库。LGPL-3.0 第 4/6 条要求：
 *   · 显著声明「本产品包含第三方开源组件」及其许可；
 *   · 允许用户**替换**该动态库（这是 LGPL 与 GPL 的关键区别，也是我们能
 *     合法动态链接的前提）；
 *   · 提供 LGPL 全文与该库的**源码获取方式**（不是只有下载地址）。
 *
 * 所以这不是「锦上添花的关于页」，是硬性合规项 —— 缺了就等于没满足 LGPL 条件。
 */
@Composable
private fun LicensesDialog(
    show: MutableState<Boolean>,
    onClose: () -> Unit,
) {
    SuperDialog(
        show = show,
        title = "开源许可",
        summary = "DSH 是 DeepSeek 开源项目；本应用另含下列第三方组件。",
        onDismissRequest = onClose,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 360.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                text = "EasyTier",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "许可：GNU Lesser General Public License v3.0（LGPL-3.0）\n" +
                    "用途：内嵌组网引擎，用于跨网络连接手机与桌面。\n" +
                    "项目主页：https://easytier.cn\n" +
                    "源码仓库：https://github.com/EasyTier/EasyTier\n" +
                    "组件源码获取：上述仓库中 easytier/、easytier-core/、easytier-proto/、\n" +
                    "easytier-contrib/easytier-ffi/、easytier-contrib/easytier-android-jni/\n" +
                    "目录，随本应用一同编译的版本号记录于「诊断 → 版本」。\n\n" +
                    "LGPL-3.0 第 4 条赋予你替换该动态库的权利：\n" +
                    "libeasytier_android_jni.so 与 libeasytier_ffi.so 以独立文件形式打包在\n" +
                    "jniLibs/arm64-v8a/ 下，你可以用自己编译的版本替换它们后重新安装本应用。\n" +
                    "替换后的库由你自行提供，本应用不限制其来源。\n\n" +
                    "完整的 LGPL-3.0 许可全文随本应用打包（见 APK 内 assets/licenses/），\n" +
                    "也可在 https://www.gnu.org/licenses/lgpl-3.0.html 在线查阅。",
                fontSize = 13.sp,
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            )
            Spacer(Modifier.height(16.dp))
            Text(
                text = "DSH",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "本应用内置的 DSH 引擎与插件版权归 DeepSeek 所有，\n" +
                    "以仓库内的 LICENSE 为准。",
                fontSize = 13.sp,
                color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
            )
        }
        Spacer(Modifier.height(20.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
        ) {
            Button(onClick = onClose, colors = primaryButtonColors()) { Text("知道了") }
        }
    }
}

/**
 * 连接对话框：桌面地址 / 端口 / 配对码 + 连接方式。
 */
@Composable
private fun LinkConnectDialog(
    init: ShellDialog.LinkConnect,
    show: MutableState<Boolean>,
    onClose: () -> Unit,
    actions: ShellActions,
) {
    var host by remember { mutableStateOf(init.host) }
    var port by remember { mutableStateOf(init.port.toString()) }
    var code by remember { mutableStateOf("") }
    // 0 = 直连，1 = 端口转发，2 = 经内嵌组网
    var modeIndex by remember { mutableStateOf(if (init.mode == "forward") 1 else if (init.mode == "overlay") 2 else 0) }
    // 组网专用参数：桌面的组网端口 + 桌面的虚拟 IP。
    var etPeerPort by remember { mutableStateOf("11010") }
    var etDstIp by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    SuperDialog(
        show = show,
        title = "连接桌面",
        summary = "首次需要桌面上的 6 位配对码（桌面上跑 link_host_start 会给）。",
        onDismissRequest = onClose,
    ) {
        Column(Modifier.fillMaxWidth()) {
            SuperSpinner(
                items = listOf(
                    SpinnerEntry(title = "直连", summary = "填桌面的真实地址：局域网 IP、公网 IPv6，或组网工具的虚拟 IP。"),
                    SpinnerEntry(
                        title = "端口转发",
                        summary = "已用 ssh 等工具把桌面端口映射到本机时选这个，地址填 127.0.0.1。",
                    ),
                    SpinnerEntry(
                        title = "经内嵌组网（推荐）",
                        summary = "与桌面不在同一网络时用这个。应用内置了组网引擎，会自动把桌面端口映射到 " +
                            "127.0.0.1 —— 不用另装 App，也不需要 VPN 权限。",
                    ),
                ),
                selectedIndex = modeIndex,
                title = "连接方式",
                onSelectedIndexChange = { modeIndex = it },
            )
            Spacer(Modifier.height(12.dp))
            MiuixTextField(
                value = host,
                onValueChange = { host = it; error = null },
                // 「经内嵌组网」时桌面地址不是填给 link 的，而是填给组网引擎去
                // 找桌面的 —— link 那头连的是 127.0.0.1。所以这里改成
                // 「桌面地址（组网用）」，避免用户以为是 link 的连接地址。
                label = when (modeIndex) {
                    1 -> "127.0.0.1"
                    2 -> "桌面地址（组网用，如 1.2.3.4）"
                    else -> "桌面地址，如 192.168.1.10"
                },
            )
            if (modeIndex == 2) {
                Spacer(Modifier.height(12.dp))
                MiuixTextField(
                    value = etPeerPort,
                    onValueChange = { etPeerPort = it.filter { c -> c.isDigit() }; error = null },
                    label = "桌面组网端口（默认 11010）",
                )
                Spacer(Modifier.height(12.dp))
                MiuixTextField(
                    value = etDstIp,
                    onValueChange = { etDstIp = it; error = null },
                    label = "桌面虚拟 IP（如 10.144.0.2）",
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "虚拟 IP 由组网网络决定，两端必须用同一个网络名。桌面侧也要跑组网引擎，" +
                        "并把虚拟 IP 固定成同一个值 —— 否则这里填的地址对不上。",
                    fontSize = 12.sp,
                    color = MiuixTheme.colorScheme.onSurfaceVariantSummary,
                )
            }
            Spacer(Modifier.height(12.dp))
            MiuixTextField(
                value = port,
                onValueChange = { port = it.filter { c -> c.isDigit() }; error = null },
                label = if (modeIndex == 1 || modeIndex == 2) "本机映射端口（默认 45731）" else "端口（默认 45731）",
            )
            Spacer(Modifier.height(12.dp))
            MiuixTextField(
                value = code,
                onValueChange = { code = it.filter { c -> c.isDigit() }.take(6); error = null },
                label = "6 位配对码（已配过就留空）",
            )
            if (error != null) {
                Spacer(Modifier.height(10.dp))
                Text(error!!, fontSize = 13.sp, color = MiuixTheme.colorScheme.error)
            }
        }
        Spacer(Modifier.height(20.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
        ) {
            Button(onClick = onClose) { Text("取消") }
            Button(
                onClick = {
                    // 地址为空是最常见的失误，在这里挡住并给出提示，
                    // 而不是发一个必然失败的请求。
                    if (host.isBlank()) {
                        error = if (modeIndex == 2) "请填桌面地址（组网用）" else "请填桌面地址"
                        return@Button
                    }
                    // 组网模式必须知道桌面的虚拟 IP —— 端口转发规则要指向它，
                    // 缺了就没法组装配置。与其发一个必然失败的请求，不如在这里说清。
                    if (modeIndex == 2 && etDstIp.isBlank()) {
                        error = "请填桌面虚拟 IP（端口转发要指向它）"
                        return@Button
                    }
                    val useOverlay = modeIndex == 2
                    onClose()
                    actions.onLinkConnect(
                        // 组网模式下 link 连的是**本机**映射端口，不是桌面地址。
                        // 桌面地址是给组网引擎用的，由 onLinkConnect 内部转交。
                        if (useOverlay) "127.0.0.1" else host.trim(),
                        port.toIntOrNull() ?: 45731,
                        code.trim(),
                        when (modeIndex) {
                            1 -> "forward"
                            2 -> "overlay"
                            else -> "direct"
                        },
                        // 组网参数（其余模式为 null）
                        if (useOverlay) {
                            OverlayParams(
                                desktopHost = host.trim(),
                                desktopPeerPort = etPeerPort.toIntOrNull() ?: 11010,
                                desktopVirtualIp = etDstIp.trim(),
                            )
                        } else null,
                    )
                },
                colors = primaryButtonColors(),
            ) { Text("连接") }
        }
    }
}

/**
 * MiuiX 输入框的薄封装。
 *
 * 统一 `singleLine` + 「label 当占位符」：v0.7.2 的 TextField 没有独立的 placeholder
 * 参数，占位符就是 `useLabelAsPlaceholder = true` 时的 label。
 */
@Composable
private fun MiuixTextField(value: String, onValueChange: (String) -> Unit, label: String) {
    top.yukonga.miuix.kmp.basic.TextField(
        value = value,
        onValueChange = onValueChange,
        label = label,
        useLabelAsPlaceholder = true,
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * 轻提示（替代 `Toast`）。
 *
 * ── 为什么不用 Toast ────────────────────────────────────────────────────────
 * Toast 是系统绘制的：圆角、配色、字体都不受应用主题控制，在一个 MiuiX 界面里
 * 显得格格不入（而且是唯一一处用系统默认观感的地方）。
 * MiuiX v0.7.2 没有 Snackbar 组件，所以这里用 Surface 画一个同风格的浮层。
 *
 * @param message 要显示的文字；null 表示不显示。
 * @param onDismiss 自动消失后的回调（用来清状态）。
 */
@Composable
fun ShellBanner(message: String?, onDismiss: () -> Unit) {
    if (message == null) return
    // 每条消息重新计时：内容一变就重新等 3 秒，而不是从第一次开始算。
    LaunchedEffect(message) {
        delay(3000)
        onDismiss()
    }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.BottomCenter) {
        // ⚠️ v0.7.2 的 Surface 收的是 `shape: Shape`，没有 `cornerRadius: Dp` 参数
        //    （Button 才有 cornerRadius）—— 已核对 Surface.kt 的签名。
        Surface(
            color = MiuixTheme.colorScheme.surfaceContainerHigh,
            shape = RoundedCornerShape(14.dp),
            shadowElevation = 6.dp,
        ) {
            Text(
                text = message,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(horizontal = 18.dp, vertical = 12.dp),
            )
        }
    }
}

/**
 * 一个信息行：左标题 + 右侧值，可选操作按钮。
 *
 * 提到顶层是为了让「远程联动」与其它分组用**同一个**行组件 —— 原先 ShellScreen 里
 * 有一份私有实现，新增 mesh 那一节时很容易顺手再写一份，两边样式就会慢慢走样。
 */
@Composable
fun ShellInfoRow(
    label: String,
    value: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
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

/** 一个分组卡片（标题 + 若干行）。统一各分组的圆角与间距。 */
@Composable
fun ShellCard(content: @Composable () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp),
    ) { content() }
}
