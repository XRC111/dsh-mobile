package com.dshdesktop.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

/**
 * 前台服务：承载 Node 引擎线程（libnode.so 跑 dsh web）。
 *
 * 与桌面外壳对应的三件事：
 * 1. 把 assets 里的 bundle（运行时 tar.gz / patch / launcher）拷到应用数据目录；
 * 2. 启动 Node 线程执行 launcher.cjs（解压→落位→import dsh bin.js）；
 * 3. 轮询 launcher 写出的 node-state.json，把 phase/url 广播给 UI。
 */
class NodeService : Service() {

    private val scope = CoroutineScope(Dispatchers.IO)
    private val handler = Handler(Looper.getMainLooper())
    private var polling = false
    private var nodeStarted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startInForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!nodeStarted) {
            nodeStarted = true
            NodeState.update(NodeState.Phase.PREPARING, "准备运行时…")
            scope.launch { bootNode() }
            startPolling()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        polling = false
        super.onDestroy()
        // node 线程随进程存续；应用被杀时一并回收
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW)
            )
        }
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        builder.setContentTitle("DSH 引擎")
            .setContentText("正在运行 DeepSeek Harness")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(pi)
            .setOngoing(true)
        val notif: Notification = builder.build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (e: Exception) {
            // 类型不被接受时降级为无类型前台服务（保命：不能因通知失败闪退）
            Log.w(TAG, "startForeground typed failed, fallback", e)
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun bootNode() {
        try {
            ensureBundledAssets()
        } catch (e: Exception) {
            Log.e(TAG, "bundle copy failed", e)
            NodeState.update(NodeState.Phase.FAILED, error = "资源准备失败：${e.message}")
            return
        }

        // 工作区必须在 Node 起来之前定好：launcher 会 chdir 过去，之后就改不了了。
        // 校验失败就退回默认私有目录，而不是把引擎卡在一个不可写的路径上。
        val chosen = Workspace.current(this)
        val workspace = if (Workspace.isUsable(chosen)) chosen else Workspace.defaultPath(this)
        if (workspace != chosen) Log.w(TAG, "workspace $chosen unusable, falling back to $workspace")
        runCatching { File(workspace).mkdirs() }
        Workspace.writeMarker(this, workspace)

        NodeState.update(NodeState.Phase.STARTING, "正在启动 DeepSeek Harness…")
        try {
            val launcher = File(filesDir, "nodejs-project/launcher.cjs").absolutePath
            val rc = NodeRunner.startNodeWithArguments(arrayOf(launcher, filesDir.absolutePath))
            when (rc) {
                0 -> { /* 已启动，等状态文件 */ }
                1 -> NodeState.update(NodeState.Phase.FAILED, error = "引擎已在运行")
                2 -> NodeState.update(NodeState.Phase.FAILED, error = "Node 线程创建失败")
                3 -> NodeState.update(
                    NodeState.Phase.FAILED,
                    error = "引擎已在本进程中启动过，请完全退出应用后重新打开",
                )
                else -> NodeState.update(NodeState.Phase.FAILED, error = "Node 引擎启动失败（rc=$rc）")
            }
        } catch (e: Throwable) {
            // libnode 加载失败（UnsatisfiedLinkError 等）走这里：状态可见而非闪退
            Log.e(TAG, "node start failed", e)
            NodeState.update(NodeState.Phase.FAILED, error = "Node 引擎异常：${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** 把 APK assets 里的 bundle 拷到应用数据目录；assets 内容变化时全量重拷。 */
    private fun ensureBundledAssets() {
        val versionMarker = File(filesDir, ".bundle-version")
        val signature = assetsSignature()
        val tarGz = File(filesDir, "bundle/dsh-runtime.bin")
        if (versionMarker.exists() && versionMarker.readText().trim() == signature
            && tarGz.exists() && tarGz.length() > 0
        ) return

        NodeState.patch("复制内置资源…")
        copyAssetDir("nodejs-project", File(filesDir, "nodejs-project"))
        copyAssetDir("bundle", File(filesDir, "bundle"))
        versionMarker.writeText(signature)
    }

    /**
     * assets 树的指纹：**全部按内容 CRC32**。
     *
     * ⚠️ 早先 `bundle/` 下的大文件（尤其 dsh-runtime.bin）只按**字节数**记指纹，
     * 理由是「CRC 耗时且无需」。这个假设三次咬人：内容变了而 gzip 后字节数恰好
     * 相同 → 判定未变 → 永不重拷 → **设备一直跑旧运行时**，表现为「明明修好了却
     * 没生效」，而构建产物、APK、tar 全部正确。
     *
     * 同一类 bug 在 launcher.cjs 里也有一处（已改成 sha256），这是第三处。
     * 44MB 的 CRC32 在设备上约 0.2s，相对首启解压（数秒到数十秒）可忽略；
     * 而且只在启动时算一次，换来的是「指纹一定反映内容」。
     */
    private fun assetsSignature(): String {
        val crc = java.util.zip.CRC32()
        val sb = StringBuilder(appVersion())
        // ⚠️ 不从 assets.list("") 起遍历：部分设备对根路径返回空列表，
        // 会让签名退化成纯版本号、与旧标记撞车 → 永远不重拷（实测踩过）
        for (top in listOf("nodejs-project", "bundle")) walk(top, sb, crc)
        return sb.toString()
    }

    private fun walk(dir: String, sb: StringBuilder, crc: java.util.zip.CRC32) {
        for (name in assets.list(dir) ?: return) {
            val child = "$dir/$name"
            if ((assets.list(child) ?: arrayOf()).isNotEmpty()) {
                walk(child, sb, crc)
                continue
            }
            var size = 0L
            var digest: Any
            assets.open(child).use { input ->
                val buf = ByteArray(1 shl 16)
                // 一律按内容算 CRC32 —— 不再对大文件退化成「只数长度」。
                crc.reset()
                var n: Int
                while (input.read(buf).also { n = it } > 0) {
                    crc.update(buf, 0, n); size += n
                }
                digest = crc.value
            }
            sb.append('|').append(child).append(':').append(digest)
        }
    }

    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
    } catch (e: Exception) { "0" }

    private fun copyAssetDir(assetDir: String, targetDir: File) {
        val children = assets.list(assetDir) ?: return
        if (children.isEmpty()) return
        targetDir.mkdirs()
        for (name in children) {
            val childAsset = "$assetDir/$name"
            val childTarget = File(targetDir, name)
            if ((assets.list(childAsset) ?: arrayOf()).isEmpty()) {
                assets.open(childAsset).use { input ->
                    childTarget.outputStream().use { output -> input.copyTo(output, 1 shl 22) }
                }
            } else {
                copyAssetDir(childAsset, childTarget)
            }
        }
    }

    private fun startPolling() {
        if (polling) return
        polling = true
        handler.post(object : Runnable {
            override fun run() {
                if (!polling) return
                try {
                    val f = File(filesDir, "node-state.json")
                    if (f.exists()) {
                        val obj = JSONObject(f.readText())
                        val phase = when (obj.optString("phase")) {
                            "starting" -> NodeState.Phase.STARTING
                            "ready" -> NodeState.Phase.READY
                            "failed" -> NodeState.Phase.FAILED
                            else -> null
                        }
                        if (phase != null && phase != NodeState.state.value.phase) {
                            NodeState.update(
                                phase,
                                message = obj.optString("message"),
                                url = obj.optString("url").takeIf { it.isNotEmpty() },
                                error = obj.optString("error").takeIf { it.isNotEmpty() },
                            )
                        } else if (phase == NodeState.Phase.STARTING) {
                            obj.optString("message").takeIf { it.isNotEmpty() }?.let { NodeState.patch(it) }
                        }
                    }
                } catch (_: Exception) {
                }
                handler.postDelayed(this, 250)
            }
        })
    }

    companion object {
        private const val TAG = "NodeService"
        private const val CHANNEL_ID = "dsh-engine"
        private const val NOTIF_ID = 1
    }
}
