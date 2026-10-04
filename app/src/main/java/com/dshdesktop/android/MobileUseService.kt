package com.dshdesktop.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * mobile_use 的宿主侧实现：无障碍服务 + 与 Node 插件的文件桥。
 *
 * ── 为什么是文件桥 ──────────────────────────────────────────────────────────
 * dsh 的工具跑在**本进程的 Node 线程**里，而这个服务是 Android 组件（主线程侧）。
 * 两者同进程但没有共享的 JS↔Java 通道：node-runner.cpp 只负责 node::Start，
 * 没有把 JNIEnv 暴露给 JS 的机制。
 *
 * 可选方案：
 *   1. Unix domain socket —— 延迟最低，但 LocalServerSocket 与 libuv 的 AF_UNIX
 *      互通性无法在开发机上验证，赌不起；
 *   2. 加 JNI 双向桥 —— 要写 .node 原生模块，工程量与风险都大；
 *   3. 文件请求/响应 —— 纯 File IO，两端都是最稳的 API。
 *
 * 选 3。代价是每步操作约 60-120ms 的轮询延迟 —— 对「看一眼→动一下」的
 * UI 自动化节奏完全够用，而它换来的是「不引入任何无法本机验证的新机制」。
 *
 * 协议（目录 filesDir/mobile-use/）：
 *   Node 写 <id>.req（先写 .tmp 再 rename，保证服务读到的一定是完整 JSON）
 *   服务读走并删除，执行后写 <id>.res（同样是 tmp+rename）
 *   Node 轮询到 <id>.res 后读取并删除
 *
 * ── 安全 ────────────────────────────────────────────────────────────────────
 * 服务只能在用户于系统设置里手动开启后运行；关掉开关即彻底失效。
 * 每个操作都写一行日志（mobile-use.log），便于事后追溯模型做了什么。
 */
class MobileUseService : AccessibilityService() {

    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    @Volatile private var polling = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        thread = HandlerThread("dsh-mobile-use").apply { start() }
        handler = Handler(thread.looper)
        polling = true
        handler.post(pollLoop)
        Log.i(TAG, "mobile-use service connected")
        logLine("service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 纯轮询模型，事件只是为了让系统认为服务在工作。
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        polling = false
        thread.quitSafely()
        Log.i(TAG, "mobile-use service unbound")
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        polling = false
        if (::thread.isInitialized) thread.quitSafely()
        super.onDestroy()
    }

    // ── 轮询循环 ─────────────────────────────────────────────────────────────

    private val pollLoop = object : Runnable {
        override fun run() {
            if (!polling) return
            try {
                drainRequests()
            } catch (e: Throwable) {
                Log.w(TAG, "request drain failed", e)
            }
            handler.postDelayed(this, POLL_MS)
        }
    }

    /** 处理目录里所有待办请求，每个请求写一个响应文件。 */
    private fun drainRequests() {
        val dir = requestDir() ?: return
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(REQ_SUFFIX) } ?: return
        for (file in files) {
            val id = file.name.removeSuffix(REQ_SUFFIX)
            val payload = runCatching { JSONObject(file.readText()) }.getOrNull()
            file.delete()
            if (payload == null) {
                writeResponse(id, errorResult("请求不是合法 JSON"))
                continue
            }
            val result = try {
                dispatch(payload.optString("op"), payload.optJSONObject("args") ?: JSONObject())
            } catch (e: Throwable) {
                Log.w(TAG, "op failed: ${payload.optString("op")}", e)
                errorResult("${e.javaClass.simpleName}: ${e.message}")
            }
            writeResponse(id, result)
        }
    }

    /** 原子写响应：先写 .tmp 再 rename，避免 Node 读到半截文件。 */
    private fun writeResponse(id: String, result: JSONObject) {
        val dir = requestDir() ?: return
        val tmp = File(dir, "$id$RES_SUFFIX$TMP_SUFFIX")
        val dst = File(dir, "$id$RES_SUFFIX")
        runCatching {
            tmp.writeText(result.toString())
            if (!tmp.renameTo(dst)) {
                dst.writeText(result.toString())
                tmp.delete()
            }
        }.onFailure { Log.w(TAG, "could not write response $id", it) }
    }

    private fun requestDir(): File? {
        val dir = File(filesDir, "mobile-use")
        if (!dir.isDirectory && !dir.mkdirs()) return null
        return dir
    }

    /** 追加一行操作日志（失败静默：日志不该影响功能）。 */
    private fun logLine(message: String) {
        runCatching {
            File(filesDir, "mobile-use.log").appendText(
                java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date()) +
                    "  " + message + "\n"
            )
        }
    }

    // ── 操作分发 ─────────────────────────────────────────────────────────────

    private fun dispatch(op: String, args: JSONObject): JSONObject {
        logLine(op + " " + args.toString().take(200))
        return when (op) {
            "status" -> status()
            "screenshot" -> screenshot()
            "nodes" -> nodes(args)
            "tap" -> tap(args)
            "swipe" -> swipe(args)
            "text" -> inputText(args)
            "key" -> globalKey(args)
            else -> errorResult("未知操作：$op")
        }
    }

    private fun status(): JSONObject {
        val metrics = resources.displayMetrics
        return JSONObject()
            .put("ok", true)
            .put("width", metrics.widthPixels)
            .put("height", metrics.heightPixels)
            .put("density", metrics.density.toDouble())
            .put("sdk", Build.VERSION.SDK_INT)
    }

    /** 截屏：走 API 30+ 的 takeScreenshot，无需 MediaProjection 授权。 */
    private fun screenshot(): JSONObject {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return errorResult("截屏需要 Android 11+（当前 SDK ${Build.VERSION.SDK_INT}）")
        }
        val latch = CountDownLatch(1)
        var bitmap: Bitmap? = null
        var failure: String? = null
        takeScreenshot(
            android.view.Display.DEFAULT_DISPLAY,
            { runnable -> handler.post(runnable) },
            object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    try {
                        val buffer = result.hardwareBuffer
                        val bmp = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
                        // wrapHardwareBuffer 返回的是 GPU 侧只读位图，必须先拷成软件位图才能压 PNG
                        bitmap = bmp?.copy(Bitmap.Config.ARGB_8888, false)
                        buffer.close()
                    } catch (e: Throwable) {
                        failure = e.message
                    } finally {
                        latch.countDown()
                    }
                }

                override fun onFailure(errorCode: Int) {
                    failure = "takeScreenshot 失败，code=$errorCode"
                    latch.countDown()
                }
            },
        )
        if (!latch.await(SCREENSHOT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            return errorResult("截屏超时")
        }
        val shot = bitmap ?: return errorResult(failure ?: "截屏失败")
        val dir = requestDir() ?: return errorResult("无法创建输出目录")
        val file = File(dir, "shot-${System.currentTimeMillis()}.png")
        file.outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val w = shot.width
        val h = shot.height
        shot.recycle()
        return JSONObject()
            .put("ok", true)
            .put("path", file.absolutePath)
            .put("width", w)
            .put("height", h)
    }

    /**
     * 枚举可交互元素。
     *
     * 这是「点得准」的关键：无障碍节点给的是精确屏幕坐标，而模型从截图上目测
     * 按钮位置必然偏 —— 手机上按钮往往只有 40-50dp 高。
     */
    private fun nodes(args: JSONObject): JSONObject {
        val root = rootInActiveWindow ?: return errorResult("当前没有活动窗口（可能被系统限制）")
        val filter = args.optString("filter").lowercase().takeIf { it.isNotEmpty() }
        val max = args.optInt("max", 150).coerceIn(1, 1000)
        val out = JSONArray()
        walk(root, out, filter, max)
        return JSONObject()
            .put("ok", true)
            .put("package", root.packageName?.toString() ?: "")
            .put("count", out.length())
            .put("truncated", out.length() >= max)
            .put("elements", out)
    }

    /** 深度优先收集节点；interactiveOnly 时只留有动作或可编辑的节点。 */
    private fun walk(
        node: AccessibilityNodeInfo?,
        out: JSONArray,
        filter: String?,
        max: Int,
    ) {
        if (node == null || out.length() >= max) return
        val rect = Rect().also { node.getBoundsInScreen(it) }
        val text = buildString {
            node.text?.let { append(it) }
            if (node.contentDescription != null) {
                if (isNotEmpty()) append(' ')
                append(node.contentDescription)
            }
        }.toString().trim()
        val clickable = node.isClickable || node.isLongClickable
        val editable = node.isEditable
        val scrollable = node.isScrollable
        val interesting = clickable || editable || scrollable
        val matches = filter == null || text.lowercase().contains(filter)
        if (interesting && matches && out.length() < max) {
            out.put(
                JSONObject()
                    .put("text", text)
                    .put("class", node.className?.toString() ?: "")
                    .put("x", rect.left).put("y", rect.top)
                    .put("w", rect.width()).put("h", rect.height())
                    .put("cx", rect.centerX()).put("cy", rect.centerY())
                    .put("clickable", clickable)
                    .put("editable", editable)
                    .put("scrollable", scrollable)
                    .put("enabled", node.isEnabled)
                    .put("selected", node.isSelected)
                    .put("checkable", node.isCheckable)
                    .put("checked", node.isChecked),
            )
        }
        for (i in 0 until node.childCount) {
            if (out.length() >= max) return
            walk(node.getChild(i), out, filter, max)
        }
    }

    private fun tap(args: JSONObject): JSONObject {
        val x = args.optDouble("x", Double.NaN)
        val y = args.optDouble("y", Double.NaN)
        if (x.isNaN() || y.isNaN()) return errorResult("tap 需要 x / y")
        return gesture({ path -> path.moveTo(x.toFloat(), y.toFloat()) })
    }

    private fun swipe(args: JSONObject): JSONObject {
        val x1 = args.optDouble("x1", Double.NaN)
        val y1 = args.optDouble("y1", Double.NaN)
        val x2 = args.optDouble("x2", Double.NaN)
        val y2 = args.optDouble("y2", Double.NaN)
        if (x1.isNaN() || y1.isNaN() || x2.isNaN() || y2.isNaN()) {
            return errorResult("swipe 需要 x1 / y1 / x2 / y2")
        }
        val duration = args.optInt("durationMs", 300).coerceIn(1, 5000)
        return gesture({ path -> path.moveTo(x1.toFloat(), y1.toFloat()); path.lineTo(x2.toFloat(), y2.toFloat()) }, duration)
    }

    /** 用 dispatchGesture 派发一个手势并等结果。 */
    private fun gesture(build: (Path) -> Unit, durationMs: Int = 60): JSONObject {
        val path = Path().also(build)
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.toLong())
        val description = GestureDescription.Builder().addStroke(stroke).build()
        val latch = CountDownLatch(1)
        var completed = false
        val ok = dispatchGesture(
            description,
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) { completed = true; latch.countDown() }
                override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
            },
            handler,
        )
        if (!ok) return errorResult("dispatchGesture 被拒绝（服务可能未连上）")
        if (!latch.await(GESTURE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return errorResult("手势超时")
        val result = JSONObject().put("ok", completed).put("completed", completed)
        if (!completed) result.put("error", "手势被系统取消")
        return result
    }

    /** 输入文本：优先直接给焦点节点设文本，失败则退回剪贴板粘贴。 */
    private fun inputText(args: JSONObject): JSONObject {
        val value = args.optString("value")
        if (value.isEmpty()) return errorResult("text 需要 value")
        val root = rootInActiveWindow
        val target = root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (target != null && target.isEditable) {
            val bundle = android.os.Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
            }
            val done = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
            if (done) return JSONObject().put("ok", true).put("method", "setText")
        }
        return errorResult("没有可编辑的焦点控件；请先点击输入框（或改用 key 输入）")
    }

    /** 全局按键：返回 / 主页 / 最近任务 / 通知栏。 */
    private fun globalKey(args: JSONObject): JSONObject {
        val name = args.optString("name").lowercase()
        val action = when (name) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents" -> GLOBAL_ACTION_RECENTS
            "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            else -> return errorResult("未知按键：$name（可用 back/home/recents/notifications/quick_settings）")
        }
        val ok = performGlobalAction(action)
        return JSONObject().put("ok", ok)
    }

    private fun errorResult(message: String): JSONObject =
        JSONObject().put("ok", false).put("error", message)

    companion object {
        private const val TAG = "DshMobileUse"
        private const val POLL_MS = 60L
        private const val SCREENSHOT_TIMEOUT_MS = 5000L
        private const val GESTURE_TIMEOUT_MS = 5000L
        private const val REQ_SUFFIX = ".req"
        private const val RES_SUFFIX = ".res"
        private const val TMP_SUFFIX = ".tmp"

        /** 服务是否已被用户在系统设置里启用。 */
        fun isEnabled(context: android.content.Context): Boolean {
            val expected = android.content.ComponentName(context, MobileUseService::class.java)
            val manager = context.getSystemService(android.content.Context.ACCESSIBILITY_SERVICE)
                as? android.view.accessibility.AccessibilityManager ?: return false
            return manager.getEnabledAccessibilityServiceList(
                android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK
            ).any { info ->
                val id = info.id
                id != null && android.content.ComponentName.unflattenFromString(id) == expected
            }
        }
    }
}
