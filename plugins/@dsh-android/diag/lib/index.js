/**
 * DSH Android 兼容性诊断 —— 宿主侧工具。
 *
 * 存在的理由：前面几轮排查全靠「改一版 → 装到设备 → 看报错 → 再猜」，因为开发机
 * 是 Windows/x64，加载不了 arm64 的 .node，也无法复现 Android 的 SELinux 行为。
 * 这个插件把那些「只有设备上才答得出」的问题变成一次工具调用，输出确定答案，
 * 而不是继续推断。
 *
 * 它做六件事：
 *   1. 打印运行时路径事实（cwd/execPath/argv0/TMPDIR/HOME/PATH 有效性）；
 *   2. 从 /proc/self/maps 确认 libnode.so 是否已加载、加载在哪；
 *   3. **实际 dlopen 每个原生插件**，报告成功/失败与确切错误 —— 这是最关键的一项，
 *      因为 napi 符号解析失败只在真正加载时才暴露；
 *   4. 测 worker_threads 是否可用；
 *   5. 测文件系统语义：link(2) 是否被 SELinux 拒绝、/tmp 是否存在、可写性；
 *   6. 确认 node:child_process 是否可用（它绕过 ctx.subprocess provider，是个陷阱）。
 *
 * 全部只读，不改任何状态。
 *
 * @module @dsh-android/diag
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const require = createRequire(import.meta.url)

/** 输出 schema 片段（dsh 要求 additionalProperties 显式给出）。 */
const textOut = (props) => ({
  schema: { type: 'object', additionalProperties: false, properties: props },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})

/**
 * 试加载一个模块，返回结构化结果。
 *
 * ⚠️ dlopen 失败在 Node 里是**可捕获的 JS 异常**，不会崩进程，所以这里安全。
 *
 * @param {string} specifier - 模块说明符或绝对路径。
 * @returns {{specifier: string, ok: boolean, detail: string}} 加载结果。
 */
function tryLoad(specifier) {
  try {
    require(specifier)
    return { specifier, ok: true, detail: 'loaded' }
  } catch (error) {
    const code = error?.code ?? ''
    const message = String(error?.message ?? error).split('\n')[0]
    return { specifier, ok: false, detail: (code ? code + ': ' : '') + message }
  }
}

/**
 * 从 /proc/self/maps 找出 libnode 的映射方式。
 *
 * ⚠️ 不要假设它一定以 "libnode.so" 结尾 —— Android 可以直接从 APK 映射
 * native 库（条目形如 .../base.apk 或 .../base.apk!/lib/arm64-v8a/libnode.so），
 * 也可能带 " (deleted)" 后缀。第一版用严格结尾匹配，设备上返回了
 * "(NONE — libnode 未加载?)"，而 node 明明在跑 —— 说明匹配方式错了，不是库没加载。
 *
 * 这里改成：凡是行内出现 "libnode" 或 ".apk" 的映射都原样带回来，
 * 让调用方看到真实形态，而不是被我的正则过滤掉。
 * @returns {{mappings: string[], unreadable: string|null}} 原始映射行。
 */
function libnodeMaps() {
  try {
    const maps = fs.readFileSync('/proc/self/maps', 'utf8')
    const found = new Set()
    for (const line of maps.split('\n')) {
      if (!/libnode|\.apk/i.test(line)) continue
      const slash = line.indexOf('/')
      found.add(slash < 0 ? line.trim() : line.slice(slash).trim())
    }
    return { mappings: [...found].slice(0, 12), unreadable: null }
  } catch (error) {
    return { mappings: [], unreadable: String(error?.message ?? error) }
  }
}

/** 收集路径事实。 */
function pathFacts() {
  const entries = (process.env.PATH ?? '').split(':').filter(Boolean)
  return {
    cwd: process.cwd(),
    execPath: process.execPath,
    argv0: process.argv0,
    nodeVersion: process.version,
    platform: process.platform + '-' + process.arch,
    tmpdir: os.tmpdir(),
    tmpdirExists: fs.existsSync(os.tmpdir()),
    home: process.env.HOME ?? '(unset)',
    dshHome: process.env.DSH_HOME ?? '(unset)',
    filesDir: process.env.DSH_ANDROID_FILES_DIR ?? '(unset)',
    pathEntries: entries.map((e) => e + (fs.existsSync(e) ? '' : ' (MISSING)')),
    slashTmpExists: fs.existsSync('/tmp'),
    slashTmpWritable: (() => {
      try {
        fs.accessSync('/tmp', fs.constants.W_OK)
        return true
      } catch {
        return false
      }
    })(),
  }
}

/** 测文件系统语义：硬链接、exec 位。 */
function fsSemantics() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-diag-'))
  const result = {}
  const src = path.join(dir, 'a')
  fs.writeFileSync(src, 'x')
  try {
    fs.linkSync(src, path.join(dir, 'b'))
    result.link = 'supported'
  } catch (error) {
    result.link = 'DENIED — ' + (error?.code ?? '') + ' (SELinux neverallow untrusted_app app_data_file:file link)'
  }
  try {
    const exclusive = path.join(dir, 'c')
    const fd = fs.openSync(exclusive, 'wx')
    fs.closeSync(fd)
    let second = 'created again (WRONG)'
    try {
      fs.openSync(exclusive, 'wx')
    } catch (error) {
      second = error?.code ?? 'error'
    }
    result.exclusiveCreate = 'works; second attempt -> ' + second
  } catch (error) {
    result.exclusiveCreate = 'FAILED — ' + (error?.code ?? '')
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
  return result
}

/**
 * 比较两条子进程路径 —— 这是决定 subprocess Provider 该用哪个的关键实验。
 *
 * 背景：早先为 Android 写了 @dsh-android/subprocess-rs（基于原生 addon），
 * 理由是「Android 上不能用 child_process.spawn」。但那个前提可能把两件事混了：
 * Android 10 禁的是 **app 私有目录内**的 exec，而 /system/bin/sh 在系统分区，
 * 本来就可以 exec。如果 node:child_process 能起来，就不需要任何原生 addon ——
 * 也就没有 napi 符号解析问题。
 *
 * 本函数把两条路都实测一遍，用事实决定，而不是继续推断。
 * @returns {Promise<object>} 两条路径的结果。
 */
async function spawnTest() {
  const result = {}
  // 路 1：原生 node:child_process（dsh-subprocess-local 走的就是它）
  try {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('/system/bin/sh', ['-c', 'echo CHILD_OK; id -u'], { encoding: 'utf8', timeout: 5000 })
    result.childProcess = {
      status: r.status,
      stdout: String(r.stdout ?? '').trim().slice(0, 120),
      stderr: String(r.stderr ?? '').trim().slice(0, 120),
      error: r.error ? String(r.error.code ?? r.error.message) : null,
    }
  } catch (error) {
    result.childProcess = { error: String(error?.message ?? error).slice(0, 160) }
  }
  // 路 2：另一个常见位置（有些设备 sh 在 /system/bin/sh，有的软链到 toybox）
  try {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync('/system/bin/toybox', ['echo', 'TOYBOX_OK'], { encoding: 'utf8', timeout: 5000 })
    result.toybox = { status: r.status, stdout: String(r.stdout ?? '').trim().slice(0, 80), error: r.error ? String(r.error.code) : null }
  } catch (error) {
    result.toybox = { error: String(error?.message ?? error).slice(0, 120) }
  }
  return result
}

/** 测 worker_threads。 */
async function workerTest() {
  try {
    const { Worker } = await import('node:worker_threads')
    const value = await new Promise((resolve, reject) => {
      const w = new Worker('require("node:worker_threads").parentPort.postMessage(40 + 2)', { eval: true })
      const timer = setTimeout(() => { w.terminate(); reject(new Error('timeout')) }, 5000)
      w.once('message', (m) => { clearTimeout(timer); resolve(m); w.terminate() })
      w.once('error', (e) => { clearTimeout(timer); reject(e) })
    })
    return { ok: value === 42, detail: 'worker returned ' + value }
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error).split('\n')[0] }
  }
}

/** 注册诊断工具。 */
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'android_diag',
    description:
      'Android 兼容性诊断：探测运行时路径、libnode 映射、**实际 dlopen 每个原生插件**、' +
      'worker 线程、文件系统语义（硬链接/独占创建）、child_process 可用性。' +
      '只读，不改状态。排查「插件加载不了 / 命令跑不起来」时先跑这个。',
    parameters: {},
    output: textOut({
      paths: { type: 'object', additionalProperties: true },
      libnodeMaps: { type: 'object', additionalProperties: true },
      spawnTest: { type: 'object', additionalProperties: true },
      nativeAddons: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            specifier: { type: 'string' },
            ok: { type: 'boolean' },
            detail: { type: 'string' },
          },
        },
      },
      workerThreads: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
      },
      fsSemantics: { type: 'object', additionalProperties: true },
      childProcess: { type: 'string' },
    }),
    async execute() {
      // 原生插件清单：能在这里列全，是因为交付物里只有这两个 .node（见 audit-native.mjs）。
      const addons = [
        // ⚠️ 这个最值得测：它没有 DT_NEEDED libnode.so，41 个 napi_* 未解析，
        // 之前「本轮运行失败」就是它（惰性加载，第一次 spawn 才暴露）。
        '@rs-cross-spawn/android-arm64',
      ]
      // flock binding 走绝对路径（它不在插件包自己的 node_modules 里）。
      const filesDir = process.env.DSH_ANDROID_FILES_DIR
      if (filesDir) {
        addons.push(path.join(filesDir, 'dsh-home/profiles/web/node_modules/@dsh-android/subprocess-rs/node_modules/@rs-cross-spawn/android-arm64/rs-cross-spawn.node'))
      }

      let childProcess
      try {
        await import('node:child_process')
        childProcess = 'importable — 但它**绕过** ctx.subprocess，Android 上会因 exec 限制失败；'
          + '正常路径应走 ctx.subprocess（subprocess-rs）'
      } catch (error) {
        childProcess = 'unavailable: ' + String(error?.message ?? error)
      }

      return {
        paths: pathFacts(),
        libnodeMaps: libnodeMaps(),
        spawnTest: await spawnTest(),
        nativeAddons: addons.map(tryLoad),
        workerThreads: await workerTest(),
        fsSemantics: fsSemantics(),
        childProcess,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Android 兼容性诊断', kind: 'read', rawInput: {} }),
  }))
}

/**
 * 只要 tools —— 不把任何服务写进 inject，缺服务时也不会整个插件加载失败。
 */
export const name = '@dsh-android/diag'
export const inject = ['tools']

export { apply }
