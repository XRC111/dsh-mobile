package com.dshdesktop.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings

/**
 * mobile_use 的启用引导。
 *
 * 无障碍服务是**特殊权限里最特殊的一个**：没有任何运行时权限弹窗能授予它，
 * 也不能用 adb 之外的编程手段开启（连 adb 都要 `settings put secure` 改
 * enabled_accessibility_services，普通应用无权写）。所以这里只能：
 *   1. 跳系统无障碍设置页；
 *   2. 回来后检查是否真的开了。
 */
object MobileUse {

    /** 服务当前是否已启用。 */
    fun isEnabled(context: Context): Boolean = MobileUseService.isEnabled(context)

    /**
     * 跳到无障碍设置页。
     *
     * 先试「直接定位到本应用的服务」（部分 ROM 支持 EXTRA_COMPONENT_NAME），
     * 失败再退回无障碍列表页 —— 不同 ROM 对前者的支持差异很大。
     */
    fun openAccessibilitySettings(context: Context) {
        val component = ComponentName(context, MobileUseService::class.java)
        val direct = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            putExtra(":settings:fragment_args_key", component.flattenToString())
            putExtra(":settings:show_fragment_args", android.os.Bundle().apply {
                putString(":settings:fragment_args_key", component.flattenToString())
            })
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { context.startActivity(direct) }.onFailure {
            runCatching {
                context.startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
        }
    }
}
