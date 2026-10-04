/**
 * DSH Android 的 mobile use —— 用无障碍服务操作手机。
 *
 * 对应桌面版的 @dsh-desktop/computer-use：桌面用 Win32 合成输入，Android 只能靠
 * AccessibilityService。工具名刻意与桌面版保持一致（screen_shot / screen_elements /
 * mouse_click / key_press / key_type），模型在两端的行为习惯可以直接迁移。
 *
 * ── 设计要点 ────────────────────────────────────────────────────────────────
 *
 * 1) **坐标一律是屏幕绝对像素**，与 screen_shot 返回的宽高同一坐标系。
 *    手机上没有多显示器概念，DEFAULT_DISPLAY 就是全部。
 *
 * 2) **截图返回真图片**（image content block），不是文件路径 —— 模型能直接看见。
 *    走 ctx.attachments.saveImage()；没有 attachment 服务时降级为文件路径。
 *    图片 bytes 绝不进 value（value 要进 durable log），用一次性 shotId 表间接传。
 *
 * 3) **点按钮前先 screen_elements**。手机按钮通常只有 40-50dp 高，从截图上目测
 *    必然点偏；无障碍节点给的是精确屏幕坐标。
 *
 * ── 安全 ────────────────────────────────────────────────────────────────────
 * 这组工具能代替用户操作整台手机。默认**只注册只读工具**（截图、看元素），
 * 会改状态的（点击/输入/按键）需要 config.allowInput=true 才注册。
 * 另外无障碍服务本身也只能由用户在系统设置里手动开启 —— 两道闸。
 *
 * @module @dsh-android/mobile-use
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MobileUseBridge, bridgeDir } from './bridge.js'

// ⚠️ dsh 的 JSON schema 校验器要求 additionalProperties 必须显式 true/false
// （不给或给 undefined 都会报 JsonSchemaError）。桌面版同样踩过。
const textOut = (props) => ({
  schema: { type: 'object', additionalProperties: false, properties: props },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})

/**
 * 截图暂存表：execute 返回纯 JSON，render 再取出真正的图片内容。
 * 用 Map 而不是往 value 里塞 base64 —— value 会进 durable log，塞图片会把会话撑爆。
 */
const shots = new Map()

/**
 * 把服务写出的 PNG 变成 image content block。
 *
 * @param {object} ctx - plugin context（惰性取 attachments）。
 * @param {object} shot - 服务的返回（path/width/height）。
 * @returns {Promise<{content: object[], meta: object}>} 渲染所需的内容块。
 */
async function shotToContent(ctx, shot) {
  const bytes = fs.readFileSync(shot.path)
  const label = 'screenshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png'
  const attachments = ctx.get?.('attachments')
  if (attachments && typeof attachments.saveImage === 'function') {
    try {
      const ref = await attachments.saveImage({
        data: new Uint8Array(bytes),
        mediaType: 'image/png',
        name: label,
      })
      return {
        content: [{ type: 'image', attachment: ref }],
        meta: { width: shot.width, height: shot.height },
      }
    } catch (error) {
      ctx.logger?.warn?.('mobile-use：截图存为附件失败，改为落盘：' + String(error))
    }
  }
  // 降级：文件路径（模型可以用自己的文件工具读）
  return {
    content: [{
      type: 'text',
      text: '已截屏并保存到 ' + shot.path + '\n尺寸 ' + shot.width + '×' + shot.height
        + '\n（当前部署没有可用的图片附件服务，所以只给了文件路径）',
    }],
    meta: { width: shot.width, height: shot.height, file: shot.path },
  }
}

/**
 * 注册 mobile_use 工具。
 *
 * @param {object} ctx - cordis plugin context。
 * @param {object} [config] - allowInput 打开会改状态的工具。
 */
function apply(ctx, config) {
  let bridge
  try {
    bridge = new MobileUseBridge(bridgeDir())
  } catch (error) {
    ctx.logger?.error?.(String(error))
    return
  }
  const allowInput = config?.allowInput === true

  /** 调用服务并把 !ok 转成抛错 —— 工具层看到的是清晰失败，而不是半个结果。 */
  const call = async (op, args, options) => {
    const result = await bridge.call(op, args, options)
    if (result && result.ok === false) throw new Error('mobile_use ' + op + '：' + (result.error ?? '未知错误'))
    return result
  }

  // ── 只读：截屏 ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'screen_shot',
    description:
      '截取手机屏幕并**直接看到图片**。用于观察当前界面状态、确认操作结果。'
      + '返回 width/height 就是屏幕坐标系，可直接喂给 mouse_click。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
          shotId: { type: 'string' },
        },
      },
      render(_args, value) {
        const shot = shots.get(value?.shotId)
        if (!shot) {
          return [{ type: 'text', text: '截图 ' + (value?.width ?? '?') + '×' + (value?.height ?? '?') + '（图片已过期）' }]
        }
        shots.delete(value.shotId)
        return shot.content
      },
    },
    async execute() {
      const shot = await call('screenshot', {}, { timeoutMs: 12000 })
      const content = await shotToContent(ctx, shot)
      const shotId = 'shot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      shots.set(shotId, content)
      return { width: shot.width, height: shot.height, shotId }
    },
    presentCall: () => ({ card: 'generic', title: '截取屏幕', kind: 'read', rawInput: {} }),
  }))

  // ── 只读：枚举界面元素（精确坐标，治「点偏」）─────────────────────────────
  ctx.tools.register(defineTool({
    name: 'screen_elements',
    description:
      '列出当前界面上所有**可交互**元素及其**精确屏幕坐标**（来自无障碍节点树）。'
      + '**点之前先用它拿坐标**，比从截图目测准得多 —— 手机按钮往往只有 40-50dp 高。'
      + '返回里 cx/cy 就是可直接传给 mouse_click 的中心点。',
    parameters: {
      filter: { type: 'string', description: '可选：按文字/描述子串过滤（不区分大小写）' },
      max: { type: 'integer', description: '最多返回条数，默认 150' },
    },
    output: textOut({
      package: { type: 'string' },
      count: { type: 'integer' },
      truncated: { type: 'boolean' },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            class: { type: 'string' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            w: { type: 'integer' },
            h: { type: 'integer' },
            cx: { type: 'integer' },
            cy: { type: 'integer' },
            clickable: { type: 'boolean' },
            editable: { type: 'boolean' },
            scrollable: { type: 'boolean' },
            enabled: { type: 'boolean' },
            selected: { type: 'boolean' },
            checkable: { type: 'boolean' },
            checked: { type: 'boolean' },
          },
        },
      },
    }),
    async execute(args) {
      const result = await call('nodes', {
        ...(args?.filter ? { filter: String(args.filter) } : {}),
        ...(args?.max ? { max: Number(args.max) } : {}),
      })
      return {
        package: result.package ?? '',
        count: result.count ?? 0,
        truncated: result.truncated === true,
        elements: result.elements ?? [],
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.filter ? '列出界面元素（匹配「' + args.filter + '」）' : '列出界面元素',
      kind: 'read',
      rawInput: args,
    }),
  }))

  // ── 只读：服务状态 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'mobile_status',
    description: '查看 mobile_use 的可用状态：屏幕尺寸、Android 版本。无障碍服务未开启时这里会明确报错。',
    parameters: {},
    output: textOut({
      width: { type: 'integer' },
      height: { type: 'integer' },
      density: { type: 'number' },
      sdk: { type: 'integer' },
    }),
    async execute() {
      const s = await call('status', {})
      return { width: s.width, height: s.height, density: s.density, sdk: s.sdk }
    },
    presentCall: () => ({ card: 'generic', title: '查看 mobile_use 状态', kind: 'read', rawInput: {} }),
  }))

  if (!allowInput) {
    ctx.logger?.info?.(
      'mobile-use：只注册了只读工具（截图/元素/状态）。'
      + '要让模型能点击和输入，在 patch 的 config 里加 allowInput: true。',
    )
    return
  }

  // ── 以下会改变设备状态 ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'mouse_click',
    description:
      '在屏幕坐标处点击（触摸屏语义）。强烈建议坐标来自 screen_elements 的 cx/cy —— '
      + '那是无障碍节点的精确中心，目测会点偏。省略 x/y 则点击屏幕中心。',
    parameters: {
      x: { type: 'integer', description: '可选：屏幕绝对 X' },
      y: { type: 'integer', description: '可选：屏幕绝对 Y' },
      long: { type: 'boolean', description: '可选：长按（默认 false）' },
    },
    output: textOut({ ok: { type: 'boolean' }, completed: { type: 'boolean' } }),
    async execute(args) {
      const s = await call('status', {})
      const x = args?.x ?? Math.round((s.width ?? 0) / 2)
      const y = args?.y ?? Math.round((s.height ?? 0) / 2)
      // 长按 = 同一位置按住 600ms；dispatchGesture 的 stroke 时长就是按住时长。
      const result = args?.long === true
        ? await call('swipe', { x1: x, y1: y, x2: x, y2: y, durationMs: 600 })
        : await call('tap', { x, y })
      return { ok: result.ok === true, completed: result.completed === true }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: (args?.long === true ? '长按' : '点击') + (args?.x !== undefined ? ' (' + args.x + ', ' + args.y + ')' : ' 屏幕中心'),
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'mouse_scroll',
    description:
      '滑动屏幕（内容滚动 / 翻页）。delta 为负向下滚（内容上移）、为正向上滚，'
      + '单位是像素，默认一次滑动屏幕高度的 1/3。x/y 是滑动起点，省略则用屏幕中心。',
    parameters: {
      delta: { type: 'integer', description: '滑动距离，负数向下滚' },
      x: { type: 'integer', description: '可选：起点 X' },
      y: { type: 'integer', description: '可选：起点 Y' },
    },
    output: textOut({ ok: { type: 'boolean' }, completed: { type: 'boolean' } }),
    async execute(args) {
      const s = await call('status', {})
      const height = s.height ?? 1000
      const width = s.width ?? 600
      const delta = args?.delta ?? -Math.round(height / 3)
      const x = args?.x ?? Math.round(width / 2)
      const y = args?.y ?? Math.round(height / 2)
      // 手指上移 = 内容上移 = 向下浏览，所以起点在中心、终点减去 delta。
      const result = await call('swipe', {
        x1: x, y1: y,
        x2: x, y2: Math.max(1, Math.min(height - 1, y + delta)),
        durationMs: 300,
      })
      return { ok: result.ok === true, completed: result.completed === true }
    },
    presentCall: (args) => ({ card: 'generic', title: '滑动屏幕', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'key_press',
    description:
      '按系统按键：back（返回）、home（主页）、recents（最近任务）、'
      + 'notifications（下拉通知栏）、quick_settings（快捷设置）。',
    parameters: {
      name: { type: 'string', required: true, description: 'back / home / recents / notifications / quick_settings' },
    },
    output: textOut({ ok: { type: 'boolean' } }),
    async execute(args) {
      const result = await call('key', { name: String(args.name) })
      return { ok: result.ok === true }
    },
    presentCall: (args) => ({ card: 'generic', title: '按键 ' + (args?.name ?? ''), kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'key_type',
    description:
      '向当前获得焦点的输入框输入文本（支持中文与任意 Unicode）。'
      + '**先用 mouse_click 点中输入框**，否则没有可编辑的焦点控件。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本' },
    },
    output: textOut({ ok: { type: 'boolean' }, method: { type: 'string' } }),
    async execute(args) {
      const result = await call('text', { value: String(args.text) })
      return { ok: result.ok === true, method: result.method ?? 'setText' }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '输入文本（' + String(args?.text ?? '').length + ' 字）',
      kind: 'other',
      rawInput: args,
    }),
  }))
}

/**
 * 只要 tools —— attachments 是可选依赖（截图能降级为文件路径），
 * 写进 inject 会让缺该服务的部署整个插件加载失败。
 *
 * ⚠️ 必须导出**具名对象**而不是 `export default apply`：cordis 从插件对象上读
 * `inject`，而 default 导出的是一个函数，函数上挂不住 inject —— 实测报
 * `cannot get property "tools" without inject`。桌面版 computer-use 同样是
 * `export { name, inject, apply }`。
 */
export const name = '@dsh-android/mobile-use'
export const inject = ['tools']

export { apply }
export { MobileUseBridge, bridgeDir } from './bridge.js'
