package com.dshdesktop.android

import android.annotation.SuppressLint
import android.app.AlertDialog
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
import android.widget.Toast
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
                        actions = ShellActions(
                            onEnter = { openWebUi() },
                            onPickWorkspace = { chooseWorkspace() },
                            onToggleMobileUse = { toggleMobileUse() },
                            onPickPermissionMode = { pickPermissionMode() },
                            onToggleMobileUseInput = { toggleMobileUseInput() },
                            onRestart = { restartApp() },
                            onShowLogs = { showLogPaths() },
                            onLinkConnect = { promptLinkConnect() },
                            onLinkDisconnect = { linkDisconnect() },
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
                LinkSnapshot(
                    connected = v.optBoolean("connected", false),
                    desktopName = v.optJSONObject("desktop")?.optString("name").orEmpty(),
                    savedHost = v.optString("savedHost"),
                    savedPort = v.optInt("savedPort"),
                    hasToken = v.optBoolean("hasToken", false),
                    mode = v.optString("mode", "direct"),
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
     * 弹一个输入 host / 端口 / 配对码的对话框，然后连桌面。
     *
     * 用 AlertDialog + 三个 EditText 而不是跳到另一个页面：这个表单只有三项，
     * 用户填完就走 —— 多一个页面反而多一次返回。
     */
    private fun promptLinkConnect() {
        val saved = linkSnapshot.value
        val pad = (16 * resources.displayMetrics.density).toInt()
        val host = android.widget.EditText(this).apply {
            hint = "桌面地址，如 192.168.1.10"
            setText(saved.savedHost)
            inputType = android.text.InputType.TYPE_CLASS_TEXT
        }
        val port = android.widget.EditText(this).apply {
            hint = "端口（默认 45731）"
            setText(if (saved.savedPort > 0) saved.savedPort.toString() else "45731")
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }
        val code = android.widget.EditText(this).apply {
            hint = "6 位配对码（已在桌面配过就留空）"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }
        // 连接方式：两种方式填错时的报错都是"连不上"，原因却完全相反，
        // 所以让用户显式选，并在填错时由插件端给出明确说明。
        val modeDirect = android.widget.RadioButton(this).apply {
            text = "直连（填桌面真实地址）"
            isChecked = saved.mode != "forward"
        }
        val modeForward = android.widget.RadioButton(this).apply {
            text = "端口转发（EasyTier 等映射到本机，地址填 127.0.0.1）"
            isChecked = saved.mode == "forward"
        }
        val group = android.widget.RadioGroup(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            addView(modeDirect)
            addView(modeForward)
        }
        val box = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(group)
            addView(host)
            addView(port)
            addView(code)
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("连接桌面")
            .setMessage(
                "直连：在桌面上跑 link_host_start，把地址、端口和 6 位配对码填到这里。\n\n"
                    + "端口转发：先用 EasyTier 的 --port-forward 把桌面端口映射到本机，这里填 127.0.0.1。"
            )
            .setView(box)
            .setPositiveButton("连接") { _, _ ->
                val h = host.text.toString().trim()
                val p = port.text.toString().trim().toIntOrNull() ?: 45731
                val c = code.text.toString().trim()
                if (h.isEmpty()) {
                    toast("请填桌面地址")
                    return@setPositiveButton
                }
                linkConnect(h, p, c, if (modeForward.isChecked) "forward" else "direct")
            }
            .setNegativeButton("取消", null)
            .show()
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

    /** 一句短提示。 */
    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }


    private fun showLogPaths() {
        AlertDialog.Builder(this)
            .setTitle("日志")
            .setMessage(
                "引擎日志：files/dsh.log\n" +
                    "Node stderr：files/node-stderr.log\n" +
                    "mobile_use 操作：files/mobile-use.log\n" +
                    "崩溃：files/crash.log\n\n" +
                    "用 adb 取：\n" +
                    "adb shell run-as $packageName cat files/dsh.log",
            )
            .setPositiveButton("知道了", null)
            .show()
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
     */
    private fun pickPermissionMode() {
        val modes = DshSettings.PermissionMode.entries
        val labels = modes.map { it.label + "（" + it.id + "）" }.toTypedArray()
        val current = DshSettings.load(this).permissionMode
        AlertDialog.Builder(this)
            .setTitle("dsh 权限模式")
            .setSingleChoiceItems(labels, modes.indexOf(current)) { dialog, which ->
                val picked = modes[which]
                val snapshot = DshSettings.load(this).copy(permissionMode = picked)
                DshSettings.save(this, snapshot)
                pushShellState(NodeState.state.value)
                dialog.dismiss()
                if (picked != DshSettings.PermissionMode.DANGER) {
                    AlertDialog.Builder(this)
                        .setTitle("需要重启应用")
                        .setMessage(
                            picked.description + "\n\n" +
                                "Android 上没有可用的内核沙箱后端（无 bwrap / landlock），" +
                                "这个模式下的命令会以「沙箱不可用」失败。\n\n" +
                                "设置已保存，重启应用后生效。",
                        )
                        .setPositiveButton("立即重启") { _, _ -> restartApp() }
                        .setNegativeButton("稍后", null)
                        .show()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 切换 mobile_use 是否允许模型输入（点击/滑动/输入文本）。 */
    private fun toggleMobileUseInput() {
        val snapshot = DshSettings.load(this)
        DshSettings.save(this, snapshot.copy(mobileUseInput = !snapshot.mobileUseInput))
        pushShellState(NodeState.state.value)
        AlertDialog.Builder(this)
            .setTitle("需要重启应用")
            .setMessage("设置已保存，重启应用后生效。")
            .setPositiveButton("立即重启") { _, _ -> restartApp() }
            .setNegativeButton("稍后", null)
            .show()
    }

    /**
     * 开关 mobile_use。
     *
     * 无障碍服务**无法由应用自行开启或关闭** —— 连 adb 都要写 secure settings，
     * 普通应用没这个权限。所以这里只能跳设置页，让用户自己拨开关，
     * 回来后 onResume 再刷新那一行。
     */
    private fun toggleMobileUse() {
        val enabled = MobileUse.isEnabled(this)
        AlertDialog.Builder(this)
            .setTitle(if (enabled) "关闭 mobile_use" else "开启 mobile_use")
            .setMessage(
                if (enabled) {
                    "请在系统设置里关闭「DSH」的无障碍开关。\n\n关闭后 mobile_use 的全部工具立即失效。"
                } else {
                    "mobile_use 需要无障碍权限，系统不允许应用自行开启。\n\n" +
                        "接下来的设置页里找到「DSH」并打开开关。开启后模型就能：\n" +
                        "· 截屏看画面\n· 读取界面元素（精确坐标）\n· 模拟点击 / 滑动 / 输入\n\n" +
                        "也就是说它可以代替你操作这台手机。不需要时请关掉。"
                },
            )
            .setPositiveButton("去设置") { _, _ ->
                MobileUse.openAccessibilitySettings(this)
                pendingMobileUseRefresh = true
            }
            .setNegativeButton("取消", null)
            .show()
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
            AlertDialog.Builder(this)
                .setTitle("需要「所有文件访问权」")
                .setMessage(
                    "要把工作区放在共享存储（如 /sdcard/Documents）必须先授予该权限。\n\n" +
                        "这是特殊权限，系统不允许弹窗授予，需要你在接下来的设置页里手动打开开关。\n\n" +
                        "不授予也可以继续：工作区会留在应用私有目录内，仅本应用可见。",
                )
                .setPositiveButton("去设置") { _, _ ->
                    Workspace.openAllFilesAccessSettings(this)
                    pendingWorkspacePick = true
                }
                .setNegativeButton("留在私有目录") { _, _ -> pickFolder(Workspace.suggestedStart()) }
                .show()
            return
        }
        pickFolder(Workspace.suggestedStart())
    }

    /** 弹出目录浏览器并记录选择。 */
    private fun pickFolder(start: java.io.File) {
        FolderPicker.show(this, start) { picked ->
            Workspace.writeMarker(this, picked)
            pushShellState(NodeState.state.value)
            AlertDialog.Builder(this)
                .setTitle("工作区已设为")
                .setMessage("$picked\n\n重启应用后生效（当前引擎的 cwd 已经固定）。")
                .setPositiveButton("立即重启") { _, _ -> restartApp() }
                .setNegativeButton("稍后", null)
                .show()
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
