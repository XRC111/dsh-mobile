package com.dshdesktop.android

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 外壳管理的 dsh 设置：写入 `$DSH_HOME/cordis.patch.yml`。
 *
 * ── 为什么不能写 $DSH_HOME/cordis.patch.yml ────────────────────────────────
 * 直觉上应该写 home 层（dsh 文档说它「applied over every profile's own layer」），
 * 但**实测它是被 --patch 压过的**。用 --dump-config 验证：
 *
 *   dsh --profile web --patch android-patch.yml --dump-config
 *   → sandbox-policy 的 mode 仍是 android-patch.yml 的值，
 *     行尾标注 "patched by cordis.patch.yml, android-patch.yml"（按应用顺序）
 *
 * 也就是说 readProfilePatches 里 overlays（--patch）排在 home 层之后并覆盖它。
 * 所以外壳的设置必须走**自己的 --patch 文件，并排在 android-patch.yml 之后**
 * 传给 launcher —— 靠分层顺序赢，而不是靠 home 层的名义优先级。
 *
 * 文件位置固定在 filesDir/dsh-user-patch.yml，由 launcher 作为最后一个 --patch 传入。
 *
 * ── ⚠️ 补丁是整块替换 config，不是深合并 ──────────────────────────────────
 * applyEntryPatches 对非 insert 行做的是 `target[key] = value` —— 给 config
 * 就会**整个换掉**原来的 config。所以每一行都必须把它想保留的键写全，
 * 漏掉的键会退回插件自己的 schema 默认值。这是这套实现里最容易踩的坑。
 *
 * ── 空文件即默认 ──────────────────────────────────────────────────────────
 * 用户没动过任何设置时写 `[]`：不产生任何覆盖，行为与没有这个文件完全一致。
 */
object DshSettings {

    private const val TAG = "DshSettings"

    /** 权限模式：dsh 的 sandbox-policy.mode 取值。 */
    enum class PermissionMode(val id: String, val label: String, val description: String) {
        DANGER("danger-full-access", "完全访问", "不限制文件访问。Android 上没有可用的内核沙箱后端，这是如实声明。"),
        WORKSPACE("workspace-write", "仅工作区可写", "尝试限制在工作区内。Android 缺少 bwrap/landlock，命令会以「沙箱不可用」失败。"),
        READONLY("read-only", "只读", "禁止一切写入。同样依赖不存在的沙箱后端，命令会失败。"),
        ;

        companion object {
            fun of(id: String?): PermissionMode = entries.firstOrNull { it.id == id } ?: DANGER
        }
    }

    /** 一份完整的设置快照（外壳页展示用）。 */
    data class Snapshot(
        val permissionMode: PermissionMode,
        val mobileUseInput: Boolean,
    )

    /** 默认值：与 android-patch.yml 钉的一致，保证「没设置过」时行为不变。 */
    val defaults = Snapshot(permissionMode = PermissionMode.DANGER, mobileUseInput = true)

    /**
     * 外壳生成的补丁文件，由 launcher 作为**最后一个 --patch** 传给 dsh。
     *
     * 放 filesDir 根而不是 bundle/：bundle 目录会被 assets 指纹比对整目录重拷，
     * 用户设置不该跟着资源一起被覆盖。
     */
    fun patchFile(context: Context): File = File(context.filesDir, "dsh-user-patch.yml")

    /**
     * 读回当前设置。
     *
     * 不解析 YAML —— 那是另一套依赖。改为：设置同时以 JSON 存一份（见 [save]），
     * 读取走 JSON；YAML 只作为喂给 dsh 的产物。两份不一致时以 JSON 为准。
     */
    fun load(context: Context): Snapshot {
        val f = stateFile(context)
        if (!f.isFile) return defaults
        return try {
            val o = JSONObject(f.readText())
            Snapshot(
                permissionMode = PermissionMode.of(o.optString("permissionMode").takeIf { it.isNotEmpty() }),
                mobileUseInput = o.optBoolean("mobileUseInput", defaults.mobileUseInput),
            )
        } catch (e: Exception) {
            Log.w(TAG, "could not read settings, using defaults", e)
            defaults
        }
    }

    /**
     * 保存设置：写 JSON 状态 + 生成 home 层补丁。
     *
     * 两步都做是因为它们的读者不同：JSON 给外壳页回读，YAML 给 dsh 启动时读。
     * 写失败只记日志不抛 —— 设置存不下不该让应用崩，下次启动退回默认即可。
     */
    fun save(context: Context, snapshot: Snapshot) {
        runCatching {
            stateFile(context).writeText(
                JSONObject()
                    .put("permissionMode", snapshot.permissionMode.id)
                    .put("mobileUseInput", snapshot.mobileUseInput)
                    .toString(2),
            )
            val patch = patchFile(context)
            patch.parentFile?.mkdirs()
            patch.writeText(renderPatch(snapshot))
        }.onFailure { Log.w(TAG, "could not persist dsh settings", it) }
    }

    /** 外壳自己的 JSON 状态文件（与给 dsh 的 YAML 分开）。 */
    private fun stateFile(context: Context): File =
        File(context.filesDir, "dsh-settings.json")

    /**
     * 生成 home 层补丁 YAML。
     *
     * 每行都把该插件的 config 键写全（补丁是整块替换，见类注释）。
     * 权限模式同时改 sandbox-policy 与 approval：danger-full-access 下没有
     * 「更宽的模式」可升级审批，approval 必须是 never，否则 dsh 会因为
     * 找不到可升级目标而报错。
     */
    private fun renderPatch(s: Snapshot): String {
        val approval = if (s.permissionMode == PermissionMode.DANGER) "never" else "ask"
        return buildString {
            append("# 由 DSH Android 外壳生成 —— 在应用的外壳页里改，不要手编。\n")
            append("# 这一层压过 --patch（android-patch.yml），因为 home 层在其后应用。\n")
            append("- id: sandbox-policy\n")
            append("  config:\n")
            append("    mode: '").append(s.permissionMode.id).append("'\n")
            append("    workspaceRoot: !!js process.cwd()\n")
            append("- id: approval\n")
            append("  config:\n")
            append("    policy: '").append(approval).append("'\n")
            append("- id: mobile-use\n")
            append("  config:\n")
            append("    allowInput: ").append(s.mobileUseInput).append("\n")
        }
    }

    /** 当前设置是否全是默认值（用来决定要不要真的写文件）。 */
    fun isDefault(s: Snapshot): Boolean = s == defaults
}
