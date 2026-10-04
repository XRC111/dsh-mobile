package com.dshdesktop.android

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * 远程联动 —— 外壳页调用本机 dsh 的联动路由。
 *
 * ── 为什么走 HTTP 而不是直接调插件 ──────────────────────────────────────────
 * 外壳是 Kotlin，dsh 插件是 Node。两者之间没有直接调用通道，而链接插件已经
 * **为 GUI 开好了路由**（见插件里的 routes.js 导出的 ROUTE_PREFIX）：
 *   GET  /api/dsh-link/status
 *   POST /api/dsh-link/connect | /stop
 * 所以外壳只要说 HTTP 就行 —— 桌面设置页用的是同一组路由，两边行为天然一致。
 *
 * ── 鉴权：为什么必须先访问一次首页 ──────────────────────────────────────────
 * 这些路由挂在 dsh 的已鉴权 Connection 上。直接带 ?token= 调是 **401**
 * （实测过：带 token 查询参数返回 unauthorized）。浏览器能访问是因为它在加载
 * 页面时用启动 token **换了一个签名 cookie**，之后同源请求自动带上。
 *
 * 所以这里照做：
 *   1. GET <首页>?token=...  → 从 Set-Cookie 里取出 dsh-auth-* 会话 cookie
 *      （ANDROID 的 HttpURLConnection 不会自动管理 cookie，得自己拿）
 *   2. 带 cookie 调 /api/dsh-link/ 下的路由  ← 返回 200 + JSON
 *
 * ⚠️ 千万别为了省事把 token 塞进查询参数：那样服务端会拒绝，报错还很含糊。
 *
 * ── 线程 ────────────────────────────────────────────────────────────────────
 * 全部是阻塞 IO，必须在**后台线程**调用（外壳页用 Thread 包一层）。
 */
object LinkClient {

    /** 从 dsh 的 URL（含 ?token=）里解析出 base 与 token。 */
    private data class Base(val origin: String, val token: String?)

    /**
     * 解析 NodeState 给出的 URL。
     *
     * URL 形如 http://127.0.0.1:12345/?token=abc。base 取到端口为止，
     * 后面的路径与查询都丢掉 —— 我们自己拼路由。
     */
    private fun parse(dshUrl: String): Base? {
        return try {
            val u = URL(dshUrl)
            val origin = "${u.protocol}://${u.host}:${u.port}"
            // token 可能在 ?token= 里；用朴素解析而不是正则，读起来更直白。
            val token = u.query?.split('&')
                ?.firstOrNull { it.startsWith("token=") }
                ?.substringAfter("token=")
            Base(origin, token)
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 用启动 token 换会话 cookie。拿不到就返回 null，调用方据此给出提示。
     *
     * @return 可放进 Cookie 头的字符串（如 "dsh-auth-xxx=v1.yyy"）。
     */
    private fun sessionCookie(base: Base): String? {
        val token = base.token ?: return null
        return try {
            val conn = (URL("${base.origin}/?token=$token").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                instanceFollowRedirects = false
                connectTimeout = 4000
                readTimeout = 6000
            }
            try {
                // 只看头，不读 body（首页是几 MB 的 JS，没必要拉）。
                val cookies = conn.headerFields["Set-Cookie"].orEmpty()
                val value = cookies.firstOrNull { it.startsWith("dsh-auth-") } ?: return null
                value.substringBefore(';')
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            null
        }
    }

    /** 解析路由返回的 { ok, value|error }。 */
    private fun readResult(raw: String): JSONObject {
        val o = JSONObject(raw)
        if (!o.optBoolean("ok", false)) {
            throw IllegalStateException(o.optString("error", "未知错误"))
        }
        return o.optJSONObject("value") ?: JSONObject()
    }

    /**
     * 调一个联动路由。
     *
     * @param dshUrl 引擎的 URL（含 token），来自 NodeState。
     * @param path 形如 "/status"。
     * @param body POST 的 JSON 体；GET 传 null。
     * @return 路由返回的 value 对象。
     * @throws IllegalStateException 引擎没起来、鉴权失败、或路由报错时抛出（带着可显示的原因）。
     */
    fun call(dshUrl: String?, path: String, body: JSONObject?): JSONObject {
        if (dshUrl == null) throw IllegalStateException("引擎还没就绪")
        val base = parse(dshUrl) ?: throw IllegalStateException("引擎地址无法解析")
        val cookie = sessionCookie(base)
            ?: throw IllegalStateException("无法取得本地会话（引擎可能刚重启，稍后再试）")

        val conn = (URL(base.origin + "/api/dsh-link" + path).openConnection() as HttpURLConnection).apply {
            requestMethod = if (body == null) "GET" else "POST"
            connectTimeout = 5000
            readTimeout = 8000
            setRequestProperty("Cookie", cookie)
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        try {
            if (body != null) {
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            if (code !in 200..299) {
                // 401 时给出可执行的提示，而不是把 HTTP 码丢给用户。
                throw IllegalStateException(
                    if (code == 401) "本地鉴权失败（401）。重启应用后重试。" else "HTTP $code：$text"
                )
            }
            return readResult(text)
        } finally {
            conn.disconnect()
        }
    }
}
