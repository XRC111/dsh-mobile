package com.dshdesktop.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import java.io.File

/**
 * 工作区（workspace）选择与落盘。
 *
 * 背景：dsh 的工作区根由补丁里的 `workspaceRoot: process.cwd()` 决定，而
 * launcher.cjs 原本把 cwd 钉在运行时目录 —— 用户没有任何办法把工作区指到
 * 自己看得见的文件夹。这里补上那条路：
 *
 * 1. 用户选一个真实路径（不是 SAF 的 content:// URI —— dsh 要的是文件系统路径）；
 * 2. 选择结果写进 SharedPreferences，并在引擎启动前落到 filesDir/.workspace；
 * 3. launcher.cjs 读该文件，校验后 chdir 过去，于是 process.cwd() 就是工作区。
 *
 * 共享存储（/sdcard/...）需要 MANAGE_EXTERNAL_STORAGE（「所有文件访问权」）。
 * 那是特殊权限，只能引导用户去系统设置里手动开，没有弹窗可授。
 */
object Workspace {

    private const val TAG = "Workspace"
    private const val PREFS = "dsh-android"
    private const val KEY_PATH = "workspacePath"

    /** 未选择时的默认值：应用私有目录，一定能用，无需任何权限。 */
    fun defaultPath(context: Context): String = File(context.filesDir, "workspace").absolutePath

    /** 当前工作区路径（未选择过则返回默认值）。 */
    fun current(context: Context): String {
        val stored = prefs(context).getString(KEY_PATH, null)
        return if (stored.isNullOrBlank()) defaultPath(context) else stored
    }

    /** 记住用户的选择。 */
    fun set(context: Context, path: String) {
        prefs(context).edit().putString(KEY_PATH, path).apply()
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** 是否已获得「所有文件访问权」。Android 11+ 才有这个概念。 */
    fun hasAllFilesAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager() else false

    /** 跳到系统设置页，让用户为本应用开启「允许管理所有文件」。 */
    fun openAllFilesAccessSettings(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
            data = Uri.parse("package:" + context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            // 部分 ROM 不认带 package 的 action，退回不带参数的通用页
            Log.w(TAG, "app-scoped all-files settings unavailable, falling back", e)
            runCatching {
                context.startActivity(
                    Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }

    /**
     * 把选择结果落成 launcher 能读的文件。
     *
     * 写在 filesDir 而不是 bundle 目录：bundle 会被 assets 指纹比对整目录重拷，
     * 用户的设置不该跟着资源一起被覆盖。
     */
    fun writeMarker(context: Context, path: String) {
        runCatching { File(context.filesDir, ".workspace").writeText(path) }
            .onFailure { Log.w(TAG, "could not persist workspace marker", it) }
    }

    /**
     * 路径是否可当作工作区：存在、是目录、可写。
     *
     * 可写性是关键 —— 引擎启动后才失败会表现为一堆莫名其妙的工具报错，
     * 不如在 UI 里当场说清楚。
     */
    fun isUsable(path: String): Boolean {
        val dir = File(path)
        return dir.isDirectory && dir.canWrite()
    }

    /** 建议的共享存储位置，作为对话框的起始目录。 */
    fun suggestedStart(): File {
        val candidates = listOf(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
            Environment.getExternalStorageDirectory(),
        )
        return candidates.firstOrNull { it != null && it.isDirectory } ?: File("/")
    }
}
