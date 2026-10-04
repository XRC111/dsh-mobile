/**
 * 与 MobileUseService（无障碍服务）之间的文件桥。
 *
 * 为什么是文件：见 MobileUseService.kt 顶部注释 —— 同进程但没有 JS↔Java 通道，
 * 而 Unix socket 与 JNI 桥都无法在开发机上验证。文件请求/响应是两端都最稳的方案。
 *
 * 协议（$FILES_DIR/mobile-use/）：
 *   请求  <id>.req   先写 <id>.req.tmp 再 rename（保证服务读到完整 JSON）
 *   响应  <id>.res   服务同样 tmp+rename 写出
 * 双方各自读走后删除，目录因此不会累积。
 *
 * @module @dsh-android/mobile-use/bridge
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 轮询间隔：服务端也是 60ms，两端加起来单次往返约 60-120ms。 */
const POLL_MS = 25

/** 单次操作的默认超时。截屏和手势都可能慢，给足余量。 */
const DEFAULT_TIMEOUT_MS = 8000

/** 服务不在（未开启无障碍）时的错误提示，多处复用。 */
export const SERVICE_DISABLED_HINT =
  'mobile_use 的无障碍服务未启用。请在应用状态页点「开启 mobile_use」，'
  + '然后在系统设置里打开「DSH」的无障碍开关。'

/**
 * 一次请求/响应的客户端。
 */
export class MobileUseBridge {
  /**
   * @param {string} dir - 桥目录（应用 filesDir 下的 mobile-use）。
   */
  constructor(dir) {
    this.dir = dir
  }

  /** 确保目录存在。 */
  async ready() {
    await mkdir(this.dir, { recursive: true })
  }

  /**
   * 发一个操作并等结果。
   *
   * @param {string} op - 操作名（status/screenshot/nodes/tap/swipe/text/key）。
   * @param {object} [args] - 操作参数。
   * @param {object} [options] - timeoutMs 覆盖默认超时。
   * @returns {Promise<object>} 服务返回的 JSON。
   * @throws when the service never answers, naming the likely cause.
   */
  async call(op, args = {}, options = {}) {
    await this.ready()
    const id = randomUUID()
    const req = join(this.dir, id + '.req')
    const tmp = req + '.tmp'
    const res = join(this.dir, id + '.res')
    await writeFile(tmp, JSON.stringify({ op, args }), 'utf8')
    await rename(tmp, req)

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    try {
      for (;;) {
        try {
          const text = await readFile(res, 'utf8')
          await rm(res, { force: true })
          return JSON.parse(text)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        if (Date.now() > deadline) {
          // 请求没人取走 = 服务没在跑；取走了但没回 = 服务卡住。两种都提示同一件事。
          await rm(req, { force: true })
          throw new Error('mobile_use 操作 ' + op + ' 超时（' + timeoutMs + 'ms）。' + SERVICE_DISABLED_HINT)
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    } catch (error) {
      await rm(req, { force: true })
      await rm(tmp, { force: true })
      throw error
    }
  }
}

/**
 * 桥目录：与 Kotlin 侧的 File(filesDir, "mobile-use") 必须一致。
 *
 * 位置由环境变量传入而不是猜 —— launcher 把 dataDir 写进 DSH_ANDROID_FILES_DIR，
 * 插件不依赖 cwd（cwd 现在是用户选的工作区，不再是应用目录）。
 *
 * @returns {string} 绝对路径。
 * @throws when the shell did not provide the location.
 */
export function bridgeDir() {
  const filesDir = process.env.DSH_ANDROID_FILES_DIR
  if (!filesDir) {
    throw new Error(
      'mobile_use: DSH_ANDROID_FILES_DIR is not set; the Android shell must export the app files '
      + 'directory so the plugin can reach the accessibility service bridge.',
    )
  }
  return join(filesDir, 'mobile-use')
}
