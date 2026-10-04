/**
 * 文件桥的协议测试。
 *
 * 无障碍服务本身跑不了（要真机），但桥的协议是纯文件 IO，可以在开发机上
 * 用一个假服务完整验证：请求格式、原子写、响应读取、超时、清理。
 *
 * 跑法：node plugins/@dsh-android/mobile-use/test/bridge.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MobileUseBridge } from '../lib/bridge.js'

let passed = 0
const failures = []
let chain = Promise.resolve()

/** 注册一个串行测试（共享同一目录状态，不并发）。 */
function test(name, fn) {
  chain = chain.then(fn).then(
    () => { passed++; console.log('  ok  ' + name) },
    (error) => { failures.push(name); console.log('FAIL  ' + name + '\n      ' + String(error && error.message).split('\n')[0]) },
  )
}

/** 造一个临时桥目录。 */
async function makeDir() {
  return mkdtemp(join(tmpdir(), 'mobile-use-'))
}

/**
 * 一个假的无障碍服务：轮询 .req，按 handler 写回 .res。
 * @returns 停止函数。
 */
function fakeService(dir, handler) {
  let running = true
  const loop = (async () => {
    while (running) {
      let names = []
      try { names = await readdir(dir) } catch { /* 目录还没建 */ }
      for (const name of names) {
        if (!name.endsWith('.req')) continue
        const id = name.slice(0, -'.req'.length)
        const payload = JSON.parse(await readFile(join(dir, name), 'utf8'))
        await rm(join(dir, name), { force: true })
        const result = await handler(payload)
        // 与 Kotlin 侧一致：先写 .tmp 再 rename
        await writeFile(join(dir, id + '.res.tmp'), JSON.stringify(result), 'utf8')
        const { rename } = await import('node:fs/promises')
        await rename(join(dir, id + '.res.tmp'), join(dir, id + '.res'))
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  })()
  return async () => { running = false; await loop }
}

test('一次请求把 op 和 args 原样送到服务，并把结果带回来', async () => {
  const dir = await makeDir()
  const seen = []
  const stop = fakeService(dir, (payload) => {
    seen.push(payload)
    return { ok: true, echo: payload.args.value }
  })
  try {
    const bridge = new MobileUseBridge(dir)
    const result = await bridge.call('text', { value: '你好' })
    assert.equal(result.echo, '你好')
    assert.deepEqual(seen[0], { op: 'text', args: { value: '你好' } })
  } finally { await stop(); await rm(dir, { recursive: true, force: true }) }
})

test('响应读走后请求与响应文件都不残留', async () => {
  const dir = await makeDir()
  const stop = fakeService(dir, () => ({ ok: true }))
  try {
    const bridge = new MobileUseBridge(dir)
    await bridge.call('status', {})
    await new Promise((r) => setTimeout(r, 50))
    const left = (await readdir(dir)).filter((n) => n.endsWith('.req') || n.endsWith('.res'))
    assert.deepEqual(left, [], '桥目录不该累积文件，实际剩下：' + left.join(','))
  } finally { await stop(); await rm(dir, { recursive: true, force: true }) }
})

test('服务不在时超时报错，并提示去开无障碍', async () => {
  const dir = await makeDir()
  try {
    const bridge = new MobileUseBridge(dir)
    await assert.rejects(
      () => bridge.call('status', {}, { timeoutMs: 150 }),
      (error) => {
        assert.match(String(error.message), /超时/)
        assert.match(String(error.message), /无障碍/, '必须提示无障碍开关，而不是只报超时')
        return true
      },
    )
    const left = (await readdir(dir)).filter((n) => n.endsWith('.req'))
    assert.deepEqual(left, [], '超时后必须清掉自己的请求，否则服务后来会执行一个过期操作')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('服务返回 ok:false 时结果原样带回（由插件层决定是否抛错）', async () => {
  const dir = await makeDir()
  const stop = fakeService(dir, () => ({ ok: false, error: '没有可编辑的焦点控件' }))
  try {
    const bridge = new MobileUseBridge(dir)
    const result = await bridge.call('text', { value: 'x' })
    assert.equal(result.ok, false)
    assert.match(result.error, /焦点控件/)
  } finally { await stop(); await rm(dir, { recursive: true, force: true }) }
})

await chain
console.log('\n' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) process.exitCode = 1
