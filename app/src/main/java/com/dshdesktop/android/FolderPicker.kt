package com.dshdesktop.android

import android.app.AlertDialog
import android.content.Context
import android.util.Log
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import java.io.File

/**
 * 极简目录选择对话框。
 *
 * 为什么不用 SAF 的 ACTION_OPEN_DOCUMENT_TREE：它返回的是 content:// URI，
 * 而 dsh 需要的是一个真实文件系统路径（Node 的 process.chdir / fs 都吃路径）。
 * 有了「所有文件访问权」之后，直接遍历 File 树反而更简单也更正确。
 *
 * 只列出目录；隐藏目录默认折叠（. 开头），但保留一个开关，因为 .dsh 之类
 * 的目录偶尔确实要选。
 */
object FolderPicker {

    private const val TAG = "FolderPicker"

    /**
     * 弹出选择器。
     *
     * @param startAt 起始目录。
     * @param onPicked 选定后回调（绝对路径）。
     */
    fun show(context: Context, startAt: File, onPicked: (String) -> Unit) {
        val state = Holder(startAt)
        var showHiddenDirs = false
        val title = TextView(context).apply {
            setPadding(48, 32, 48, 16)
            textSize = 14f
        }
        val list = ListView(context)
        val showHidden = Button(context).apply { text = "显示隐藏目录" }
        val box = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(title)
            addView(list)
            addView(showHidden)
        }

        val dialog = AlertDialog.Builder(context)
            .setTitle("选择工作区文件夹")
            .setView(box)
            .setPositiveButton("用这个文件夹", null)
            .setNegativeButton("取消", null)
            .create()

        fun refresh() {
            title.text = state.dir.absolutePath
            val entries = state.children(showHidden = showHiddenDirs)
            list.adapter = ArrayAdapter(
                context,
                android.R.layout.simple_list_item_1,
                entries.map { it.name + if (it.isDirectory) "/" else "" },
            )
            list.setOnItemClickListener { _, _, position, _ ->
                val target = entries[position]
                when {
                    target.isDirectory -> { state.dir = target; refresh() }
                    else -> Log.d(TAG, "ignoring non-directory selection")
                }
            }
        }

        showHidden.setOnClickListener {
            showHiddenDirs = !showHiddenDirs
            showHidden.text = if (showHiddenDirs) "隐藏 . 开头的目录" else "显示隐藏目录"
            refresh()
        }

        dialog.setOnShowListener {
            refresh()
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val picked = state.dir
                if (!Workspace.isUsable(picked.absolutePath)) {
                    title.text = "不可写，换一个：\n" + picked.absolutePath
                    return@setOnClickListener
                }
                Workspace.set(context, picked.absolutePath)
                dialog.dismiss()
                onPicked(picked.absolutePath)
            }
            // 「上一级」挂在标题点击上，省一个按钮
            title.setOnClickListener {
                state.dir.parentFile?.let { state.dir = it; refresh() }
            }
        }

        dialog.show()
    }

    /** 对话框内的可变状态。 */
    private class Holder(var dir: File) {
        /**
         * 当前目录的子项：目录在前，按名字排序。
         * @param showHidden 是否包含 . 开头的目录。
         */
        fun children(showHidden: Boolean): List<File> {
            val all = dir.listFiles() ?: return emptyList()
            return all.asSequence()
                .filter { it.isDirectory }
                .filter { showHidden || !it.name.startsWith(".") }
                .filter { it.canRead() }
                .sortedBy { it.name.lowercase() }
                .toList()
        }
    }
}
