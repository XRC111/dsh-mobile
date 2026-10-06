package com.dshdesktop.android

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import org.json.JSONObject
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import java.net.URLDecoder

/**
 * 主界面：引擎未就绪时显示状态页，READY 后用 WebView 加载 dsh 的 Web UI
 * （URL 由 launcher.cjs 从 dsh 输出解析并写入状态文件，含 ?token=）。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView

    /** true 时显示 dsh 的 Web UI，false 时显示外壳页。 */
    private var showWeb = false

    /** 外壳页的 Compose 状态；由 NodeState 流与设置变化驱动重组。 */
    private val shellState = mutableStateOf<ShellState?>(null)

    /**
     * 远程联动的最近一次快照。
     *
     * 单独存而不是每次 pushShellState 都同步去问一次：路由调用是阻塞 IO，
     * pushShellState 在主线程上（状态一变就会调），不能在那里发网络请求 ——
     * 那会卡住界面。所以由 refreshLink() 在后台线程刷新后写进来。
     */
    private val linkSnapshot = mutableStateOf(LinkSnapshot())

    /**
     * 当前该显示的对话框（null = 没有）。
     *
     * 原先每个确认框都是当场 `AlertDialog.Builder(this).show()` —— 命令式、原生观感，
     * 与 MiuiX 写的外壳页格格不入。现在统一成状态：这里只写「该显示哪个」，
     * 由 ShellDialogHost 用 MiuiX 渲染。好处是不会有「弹了两个框」「框关了状态没清」
     * 这类不一致，观感也跟页面一致。
     */
    private val activeDialog = mutableStateOf<ShellDialog?>(null)

    /** 底部轻提示文字（替代 Toast）。 */
    private val banner = mutableStateOf<String?>(null)

    /** mesh 快照（本机身份 + 设备清单）。 */
    private val meshSnapshot = mutableStateOf(MeshSnapshot())

    /** 外壳页的 View 容器（ComposeView）。 */
    private lateinit var shellCompose: androidx.compose.ui.platform.ComposeView

    private var currentUrl: String? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /** 用户被引导去设置页授予文件权限后，回来时自动接着弹目录选择。 */
    private var pendingWorkspacePick = false

    /** 用户去过无障碍设置页后，回来刷新 mobile_use 按钮文字。 */
    private var pendingMobileUseRefresh = false

    private val fileChooser: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = filePathCallback
            filePathCallback = null
            if (callback == null) return@registerForActivityResult
            val uris: Array<Uri> = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
                ?: arrayOf()
            callback.onReceiveValue(uris)
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installCrashLogger()
        buildViews()
        setContentView(root)

        setupWebView()
        handleBackPress()

        // 引擎随应用启动（前台服务承载）
        ContextCompat.startForegroundService(this, Intent(this, NodeService::class.java))

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                NodeState.state.collect { render(it) }
            }
        }
    }

    /** 未捕获异常写 filesDir/crash.log（无 adb 也能排查闪退），随后交回系统默认崩溃流程。 */
    private fun installCrashLogger() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching {
                java.io.File(filesDir, "crash.log").appendText(
                    buildString {
                        append("\n==== ").append(java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date()))
                        append(" thread=").append(thread.name).append(" ====\n")
                        append(android.util.Log.getStackTraceString(throwable))
                    }
                )
            }
            previous?.uncaughtException(thread, throwable)
        }
    }

    /**
     * 外壳页面：引擎状态 + 设置入口 + 「进入 DSH」。
     *
     * 界面本体在 ShellScreen.kt（Compose + MiuiX），这里只做两件事：
     * 搭出 ComposeView 容器，以及把 NodeState/设置读成 ShellState 喂进去。
     * 这样界面层不认识 Activity、不认识 NodeState，纯数据进纯回调出。
     *
     * 刻意**不自动打开 dsh 的 Web UI**：那是引擎的界面，不是这个应用的主页。
     * 用户先看到外壳页（状态、工作区、mobile_use 都在这里管），要用了再进去。
     */
    private fun buildViews() {
        // setContent {} 里的 `this` 是 ComposeView，不是 Activity —— 回调里需要
        // Activity 时统一用这个引用。
        val activity = this
        root = FrameLayout(this).apply { fitsSystemWindows = false }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        shellCompose = ComposeView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            setContent {
                val state = shellState.value
                if (state != null) {
                    ShellScreen(
                        state = state,
                        // ⚠️ dialog / banner 必须在这里**实时读取**，不能只靠 state 里的快照。
                        //
                        // ShellState 是 pushShellState() 时抓的一份快照，而对话框状态
                        // 随时会被调用方改（点「取消」就是 activeDialog.value = null）。
                        // 只读快照的话，那个改动没有触发 pushShellState，
                        // state.dialog 就一直停在旧值 —— 表现是**对话框关不掉**。
                        // 传 MutableState 进来让 Compose 直接订阅它，改了就重组。
                        dialog = activeDialog.value,
                        banner = banner.value,
                        actions = ShellActions(
                            onEnter = { openWebUi() },
                            onPickWorkspace = { chooseWorkspace() },
                            onToggleMobileUse = { toggleMobileUse() },
                            onPickPermissionMode = { pickPermissionMode(it) },
                            onToggleMobileUseInput = { toggleMobileUseInput() },
                            onRestart = { restartApp() },
                            onShowLogs = { activeDialog.value = ShellDialog.LogPaths },
                            onPickLinkConnect = { promptLinkConnect() },
                            onLinkConnect = { host, port, code, mode -> linkConnect(host, port, code, mode) },
                            onLinkDisconnect = { linkDisconnect() },
                            onToggleLlmRelay = { enable -> toggleLlmRelay(enable) },
                            // ⚠️ 这些 lambda 里不能直接写 `this`：它们位于
                            //    ComposeView.setContent {} 内部，`this` 是 ComposeView
                            //    而不是 Activity。用 activity 显式引用（编译器会拦，
                            //    但写清楚省得下次又踩）。
                            currentPermissionMode = { DshSettings.load(activity).permissionMode },
                            onOpenMobileUseSettings = {
                                MobileUse.openAccessibilitySettings(activity)
                                pendingMobileUseRefresh = true
                            },
                            onRequestAllFilesAccess = {
                                Workspace.openAllFilesAccessSettings(activity)
                                pendingWorkspacePick = true
                            },
                            onStayPrivateWorkspace = { pickFolder(Workspace.suggestedStart()) },
                            onDismissDialog = { activeDialog.value = null },
                            onDismissBanner = { banner.value = null },
                            onSetTopology = { topology -> setTopology(topology) },
                        ),
                    )
                }
            }
        }

        webView = WebView(this).apply {
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        root.addView(shellCompose)
        root.addView(webView)
        showWebUi(false)
    }

    /**
     * 把当前状态与设置重新读成 ShellState 并推给 Compose。
     *
     * 设置（工作区 / mobile_use）与引擎状态是两路来源，所以不放在 StateFlow 里 ——
     * 每次 render 都重读一遍，用户改完设置也能立刻反映。
     */
    private fun pushShellState(state: NodeState.State) {
        val ws = Workspace.current(this)
        val external = !ws.startsWith(filesDir.absolutePath)
        val canEnter = state.phase == NodeState.Phase.READY && state.url != null
        val dsh = DshSettings.load(this)
        shellState.value = ShellState(
            phase = state.phase,
            statusLine = when (state.phase) {
                NodeState.Phase.READY -> "引擎已就绪。"
                NodeState.Phase.FAILED -> "启动失败"
                else -> state.message.ifEmpty { "正在启动…" }
            },
            workspacePath = ws,
            workspaceNeedsPermission = external && !Workspace.hasAllFilesAccess(),
            mobileUseEnabled = MobileUse.isEnabled(this),
            permissionMode = dsh.permissionMode,
            mobileUseInput = dsh.mobileUseInput,
            version = appVersionText(),
            canEnter = canEnter,
            error = if (state.phase == NodeState.Phase.FAILED) state.error else null,
            link = linkSnapshot.value,
        )
    }

    private fun render(state: NodeState.State) {
        pushShellState(state)
        when (state.phase) {
            NodeState.Phase.READY -> {
                // 引擎换过一次 URL（重启/换 token）时丢掉旧的 WebView 内容，
                // 否则用户点「进入 DSH」会看到上一次的页面。
                val url = state.url
                if (url != null && currentUrl != null && currentUrl != url) {
                    currentUrl = null
                    webView.loadUrl("about:blank")
                }
            }
            NodeState.Phase.FAILED -> {
                // 失败信息由外壳页展示（ShellState.error）
            }
            else -> Unit
        }
    }

    /** 进入 dsh 的 Web UI。 */
    private fun openWebUi() {
        val url = NodeState.state.value.url ?: return
        if (currentUrl != url) {
            currentUrl = url
            webView.loadUrl(url)
        }
        showWebUi(true)
    }

    /**
     * 在「外壳页」与「dsh Web UI」之间切换。
     * 回外壳页时清一次焦点，避免 WebView 的软键盘状态漏过去。
     */
    private fun showWebUi(show: Boolean) {
        showWeb = show
        // 回到外壳页时刷一次联动状态：手机可能在别处断开/连上了，卡片不该停在旧值。
        if (!show) refreshLink()
        webView.visibility = if (show) View.VISIBLE else View.GONE
        shellCompose.visibility = if (show) View.GONE else View.VISIBLE
        if (show) {
            webView.requestFocus()
        } else {
            currentFocus?.clearFocus()
        }
    }

    /** 日志文件位置（直接说清楚，免得用户去翻文档）。 */
// ── 远程联动 ────────────────────────────────────────────────────────────

    /**
     * 刷新联动状态（后台线程）。
     *
     * 失败**不**弹提示：外壳页每次回来都会刷一次，引擎还没起来时失败是正常的，
     * 每次都弹一句「引擎还没就绪」只会烦人。把原因放进快照，卡片上显示一行就够。
     */
    private fun refreshLink() {
        val url = NodeState.state.value.url
        Thread {
            val snap = try {
                val v = LinkClient.call(url, "/status", null)
                // mesh 段可能没有（插件版本较旧或身份初始化失败）—— 那时保持空快照，
                // 界面上「多设备」这一节会整体不显示，而不是显示一排空值。
                val m = v.optJSONObject("mesh")
                LinkSnapshot(
                    connected = v.optBoolean("connected", false),
                    desktopName = v.optJSONObject("desktop")?.optString("name").orEmpty(),
                    savedHost = v.optString("savedHost"),
                    savedPort = v.optInt("savedPort"),
                    hasToken = v.optBoolean("hasToken", false),
                    mode = v.optString("mode", "direct"),
                    llmRelayEnabled = v.optJSONObject("llmRelay")?.optBoolean("enabled", false) ?: false,
                    llmRelayAvailable = v.optJSONObject("llmRelay")?.optBoolean("available", false) ?: false,
                    mesh = if (m == null) {
                        MeshSnapshot()
                    } else {
                        val onlineArr = m.optJSONArray("online")
                        val online = buildList {
                            if (onlineArr != null) {
                                for (i in 0 until onlineArr.length()) {
                                    val o = onlineArr.optJSONObject(i) ?: continue
                                    add(
                                        (o.optString("name").ifEmpty { "未命名" }) to
                                            o.optString("deviceId"),
                                    )
                                }
                            }
                        }
                        MeshSnapshot(
                            selfId = m.optString("deviceId"),
                            selfName = m.optString("name"),
                            topology = m.optString("topology", "star"),
                            paired = m.optInt("paired", 0),
                            online = online,
                        )
                    },
                )
            } catch (e: Exception) {
                LinkSnapshot(error = e.message)
            }
            runOnUiThread {
                linkSnapshot.value = snap
                pushShellState(NodeState.state.value)
            }
        }.start()
    }

    /**
     * 切换 mesh 拓扑（star ↔ mesh）。
     *
     * 失败要明确说出来：拓扑决定「谁拨谁」，切错了表现是「设备明明在线却连不上」，
     * 不给反馈的话用户完全无从判断。
     *
     * @param topology 'star' 或 'mesh'。
     */
    private fun setTopology(topology: String) {
        val url = NodeState.state.value.url
        Thread {
            try {
                LinkClient.call(url, "/topology", JSONObject().put("topology", topology))
                runOnUiThread { refreshLink() }
            } catch (e: Exception) {
                runOnUiThread { toast("切换拓扑失败：" + (e.message ?: "未知错误")) }
            }
        }.start()
    }

    /**
     * 打开配对对话框（地址 / 端口 / 配对码 + 连接方式）。
     *
     * 这里只把「该显示哪个框」写进状态，表单本身由 ShellDialogHost 用 MiuiX 渲染 ——
     * 原先是一大段 AlertDialog + EditText + RadioGroup 的命令式拼装，观感是系统默认的，
     * 与页面其它部分完全不是一套。
     */
    private fun promptLinkConnect() {
        val saved = linkSnapshot.value
        activeDialog.value = ShellDialog.LinkConnect(
            host = saved.savedHost,
            port = if (saved.savedPort > 0) saved.savedPort else 45731,
            mode = saved.mode,
        )
        pushShellState(NodeState.state.value)
    }

    /** 真正发起配对（后台线程）。 */
    private fun linkConnect(host: String, port: Int, code: String, mode: String) {
        val url = NodeState.state.value.url
        linkSnapshot.value = LinkSnapshot(savedHost = host, savedPort = port, mode = mode)
        pushShellState(NodeState.state.value)
        Thread {
            val snap = try {
                val body = JSONObject().apply {
                    put("host", host)
                    put("port", port)
                    put("mode", mode)
                    if (code.isNotEmpty()) put("code", code)
                }
                val v = LinkClient.call(url, "/connect", body)
                LinkSnapshot(
                    connected = v.optBoolean("connected", false),
                    desktopName = v.optJSONObject("desktop")?.optString("name").orEmpty(),
                    savedHost = host,
                    savedPort = port,
                    hasToken = true,
                    mode = v.optString("mode", mode),
                )
            } catch (e: Exception) {
                LinkSnapshot(savedHost = host, savedPort = port, mode = mode, error = e.message)
            }
            runOnUiThread {
                linkSnapshot.value = snap
                pushShellState(NodeState.state.value)
                if (snap.error == null && snap.connected) toast("已连接：" + snap.desktopName)
            }
        }.start()
    }

    /** 断开（保留令牌，下次可直接重连）。 */
    private fun linkDisconnect() {
        val url = NodeState.state.value.url
        Thread {
            try {
                LinkClient.call(url, "/stop", JSONObject())
            } catch (e: Exception) {
                // 断开失败不算问题：本地状态照样清掉，免得界面卡在「已连接」。
            }
            runOnUiThread {
                linkSnapshot.value = linkSnapshot.value.copy(connected = false, desktopName = "")
                pushShellState(NodeState.state.value)
            }
        }.start()
    }

    /** 切换远程凭据转发（模型调用转发到桌面执行）。 */
    private fun toggleLlmRelay(enable: Boolean) {
        val url = NodeState.state.value.url
        Thread {
            try {
                val v = LinkClient.call(url, "/llm-relay", JSONObject().put("enabled", enable))
                runOnUiThread {
                    linkSnapshot.value = linkSnapshot.value.copy(
                        llmRelayEnabled = v.optBoolean("enabled", enable),
                        llmRelayAvailable = v.optBoolean("available", false),
                    )
                    pushShellState(NodeState.state.value)
                    toast(if (enable) "已开启：对话内容会发到桌面执行" else "已关闭远程转发")
                }
            } catch (e: Exception) {
                runOnUiThread { toast("切换失败：" + (e.message ?: "未知错误")) }
            }
        }.start()
    }

    /**
     * 一句短提示。
     *
     * 走外壳自己的底部浮层（ShellBanner），不用 Toast —— 后者由系统绘制，圆角、
     * 配色、字体都不受应用主题控制，在一个 MiuiX 界面里是唯一一处系统默认观感。
     */
    private fun toast(message: String) {
        banner.value = message
        pushShellState(NodeState.state.value)
    }


    private fun showLogPaths() {
        activeDialog.value = ShellDialog.LogPaths
        pushShellState(NodeState.state.value)
    }

    /** 版本号（外壳 + 运行环境，排障时第一个要问的东西）。 */
    private fun appVersionText(): String =
        "外壳 ${BuildConfig.VERSION_NAME}（${BuildConfig.VERSION_CODE}）· Android ${Build.VERSION.RELEASE}（SDK ${Build.VERSION.SDK_INT}）"

    /**
     * 选择 dsh 的权限模式。
     *
     * 说明里必须把 Android 的现实讲清楚：workspace-write / read-only 依赖
     * bwrap 或 landlock 做内核级限制，而 Android 上两者都不存在，选了它们
     * 命令会以「沙箱不可用」失败。这不是 bug，是平台事实，所以放在选项说明里，
     * 而不是等用户踩坑。
     *
     * 打开选择框（真正选哪个由对话框回调 [pickPermissionMode] 带回来）。
     */
    private fun pickPermissionMode() {
        activeDialog.value = ShellDialog.PermissionMode
        pushShellState(NodeState.state.value)
    }

    /**
     * 用户在对话框里选定了一个模式：保存，必要时提示重启。
     *
     * @param picked 选中的模式。
     */
    private fun pickPermissionMode(picked: DshSettings.PermissionMode) {
        val snapshot = DshSettings.load(this).copy(permissionMode = picked)
        DshSettings.save(this, snapshot)
        pushShellState(NodeState.state.value)
        // danger 模式是 Android 上唯一能真正跑命令的（没有内核沙箱可用），
        // 所以只有切到别的模式才提示「会失败 + 需重启」。
        if (picked != DshSettings.PermissionMode.DANGER) {
            activeDialog.value = ShellDialog.ConfirmRestart(
                picked.description + "\n\n" +
                    "Android 上没有可用的内核沙箱后端（无 bwrap / landlock），" +
                    "这个模式下的命令会以「沙箱不可用」失败。\n\n" +
                    "设置已保存，重启应用后生效。",
            )
            pushShellState(NodeState.state.value)
        }
    }

    /** 切换 mobile_use 是否允许模型输入（点击/滑动/输入文本）。 */
    private fun toggleMobileUseInput() {
        val snapshot = DshSettings.load(this)
        DshSettings.save(this, snapshot.copy(mobileUseInput = !snapshot.mobileUseInput))
        activeDialog.value = ShellDialog.ConfirmRestart("设置已保存，重启应用后生效。")
        pushShellState(NodeState.state.value)
    }

    /**
     * 开关 mobile_use。
     *
     * 无障碍服务**无法由应用自行开启或关闭** —— 连 adb 都要写 secure settings，
     * 普通应用没这个权限。所以这里只能跳设置页，让用户自己拨开关，
     * 回来后 onResume 再刷新那一行。
     */
    private fun toggleMobileUse() {
        activeDialog.value = ShellDialog.MobileUse(MobileUse.isEnabled(this))
        pushShellState(NodeState.state.value)
    }

    /**
     * 选择工作区。分两步：
     * 1. 想选共享存储就必须先有 MANAGE_EXTERNAL_STORAGE —— 特殊权限，只能跳设置页；
     * 2. 授权（或选择留在私有目录）后弹目录浏览器。
     *
     * 选完不立刻重启引擎：正在跑的会话不该被后台改 cwd，由「重启应用」显式生效。
     */
    private fun chooseWorkspace() {
        if (!Workspace.hasAllFilesAccess()) {
            activeDialog.value = ShellDialog.AllFilesAccess
            pushShellState(NodeState.state.value)
            return
        }
        pickFolder(Workspace.suggestedStart())
    }

    /** 弹出目录浏览器并记录选择。 */
    private fun pickFolder(start: java.io.File) {
        FolderPicker.show(this, start) { picked ->
            Workspace.writeMarker(this, picked)
            activeDialog.value = ShellDialog.WorkspaceSet(picked)
            pushShellState(NodeState.state.value)
        }
    }

    /**
     * node::Start 不支持同进程二次启动 —— 「重启引擎」实际是重启整个应用：
     * 用 AlarmManager 在 0.5s 后拉起 launcher Intent，然后杀掉进程。
     */
    private fun restartApp() {
        val intent = packageManager.getLaunchIntentForPackage(packageName)
        intent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = android.app.PendingIntent.getActivity(
            this, 1001, intent,
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
        )
        val am = getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        am.setExactAndAllowWhileIdle(
            android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP,
            android.os.SystemClock.elapsedRealtime() + 500, pi
        )
        stopService(Intent(this, NodeService::class.java))
        Runtime.getRuntime().exit(0)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            // dsh 自带主题（Android 15+ 已无 force dark，无需干预）
            // 避免系统字体缩放破坏布局
            textZoom = 100
            useWideViewPort = true
            loadWithOverviewMode = true
            userAgentString = "$userAgentString DSH-Android/${BuildConfig.VERSION_NAME}"
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        CookieManager.getInstance().setAcceptCookie(true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val current = currentUrl?.let { Uri.parse(it) } ?: return false
                // 站外链接交给系统浏览器
                return if (url.host != null && url.host != current.host) {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                    true
                } else false
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    Log.w(TAG, "main frame error: ${error.description}")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                if (filePathCallback != null) {
                    filePathCallback?.onReceiveValue(arrayOf())
                    return true
                }
                filePathCallback = callback
                val intent = params.createIntent().apply { addCategory(Intent.CATEGORY_OPENABLE) }
                return try {
                    fileChooser.launch(intent)
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    false
                }
            }
        }

        // 交付物/附件下载走系统 DownloadManager（带上 WebView 的 cookie）
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, name)
                    mimeType?.let { setMimeType(it) }
                    CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                    addRequestHeader("User-Agent", userAgent)
                }
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
            } catch (e: Exception) {
                Log.w(TAG, "download failed", e)
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            }
        }
    }

    /**
     * 返回键的层级：WebView 内部历史 → 回外壳页 → 退出应用。
     *
     * 第二层是关键 —— 进了 dsh 之后返回键必须能回到外壳页，否则用户会被
     * 困在 Web UI 里，只能靠杀进程出来。
     */
    private fun handleBackPress() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    showWeb && webView.canGoBack() -> webView.goBack()
                    showWeb -> showWebUi(false)
                    else -> finish()
                }
            }
        })
    }

    /**
     * 从系统设置页回来时检查授权结果：
     * 用户刚去过设置且现在有权限了，就直接接着弹目录选择，省一次点击。
     */
    override fun onResume() {
        super.onResume()
        if (pendingMobileUseRefresh) {
            pendingMobileUseRefresh = false
        }
        if (!pendingWorkspacePick) return
        pendingWorkspacePick = false
        if (Workspace.hasAllFilesAccess()) {
            pickFolder(Workspace.suggestedStart())
        } else {
            pushShellState(NodeState.state.value)
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MainActivity"
    }
}
