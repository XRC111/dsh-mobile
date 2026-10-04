/**
 * Host-side tests for the Android subprocess provider.
 *
 * The provider cannot run its real substrate off-device, so these tests drive
 * the seam through a fake addon that reproduces the native contract: async
 * `(error, value)` callbacks, a `{ pid, kill() }` child, and an exit callback
 * that can arrive after the last output chunk.
 *
 * Run: node plugins/subprocess-rs/test/provider.test.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AndroidSubprocessHandle, spawnViaAddon, validateSpec } from '../lib/spawn.js'

let passed = 0
const failures = []

/** Register one test. */
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok  ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL  ' + name)
    console.log('      ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : String(error)))
  }
}

/** Await a macrotask boundary so queued callbacks run. */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/**
 * A fake addon that records its call and lets the test drive output and exit.
 * @param options - whether to fail the start, and the exit code to report.
 * @returns the bridge plus the captured start arguments and drive handles.
 */
function fakeBridge(options = {}) {
  const state = { cmd: undefined, args: undefined, options: undefined, killed: 0, signals: [] }
  const bridge = {
    path: '/fake/rs-cross-spawn.node',
    start(cmd, args, spawnOptions, onStdout, onStderr, onExit) {
      state.cmd = cmd
      state.args = args
      state.options = spawnOptions
      state.onStdout = onStdout
      state.onStderr = onStderr
      state.onExit = onExit
      if (options.failStart === true) throw new Error('[spawn] program not found')
      return {
        pid: options.pid ?? 4242,
        kill() { state.killed++ },
      }
    },
  }
  return { bridge, state }
}

/** A minimal valid spec with collect-mode streams. */
function spec(overrides = {}) {
  return {
    argv: ['/system/bin/sh', '-c', 'echo hi'],
    cwd: '/data',
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: 50,
    ...overrides,
  }
}

console.log('subprocess-rs provider')

test('validateSpec rejects a control channel, which the addon cannot carry', () => {
  assert.throws(
    () => validateSpec(spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' } })),
    /stdio\.control is unsupported on Android/,
  )
})

test('validateSpec rejects a non-positive grace and an empty argv', () => {
  assert.throws(() => validateSpec(spec({ graceMs: 0 })), /graceMs/)
  assert.throws(() => validateSpec(spec({ argv: [] })), /invalid argv/)
})

test('validateSpec rejects a pre-aborted signal before any native work', () => {
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled'))
  assert.throws(() => validateSpec(spec({ signal: controller.signal })), /aborted before spawn: Error: caller cancelled/)
})

test('a start failure rejects done and never throws synchronously', async () => {
  const { bridge } = fakeBridge({ failStart: true })
  const handle = spawnViaAddon(spec(), bridge)
  await assert.rejects(handle.done, /program not found/)
})

test('collect mode keeps a byte-exact tail and reports the whole-stream offset', () => {
  const { bridge, state } = fakeBridge()
  const handle = spawnViaAddon(spec({ stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } } }), bridge)
  state.onStdout(Buffer.from('0123456789'))
  const read = handle.collected.stdout.readFrom(0)
  assert.equal(read.text, '23456789', 'overflow keeps the tail')
  assert.equal(read.nextOffset, 10, 'offsets stay in whole-stream coordinates')
  assert.equal(read.lossy, true, 'a reader that fell behind the window is told so')
  const resumed = handle.collected.stdout.readFrom(10)
  assert.equal(resumed.text, '', 'an up-to-date reader sees no delta')
  const fresh = handle.collected.stdout.readFrom(2)
  assert.equal(fresh.lossy, false, 'a reader inside the window is not lossy')
  assert.equal(fresh.text, '23456789')
})

test('a read below the retained window is lossy and returns the tail', () => {
  const { bridge, state } = fakeBridge()
  const handle = spawnViaAddon(spec({ stdio: { stdin: 'ignore', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } } }), bridge)
  state.onStdout(Buffer.from('abcdefgh'))
  const read = handle.collected.stdout.readFrom(0)
  assert.equal(read.text, 'efgh')
  assert.equal(read.lossy, true)
})

test('collect mode can spill the complete stream to a file', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rs-test-'))
  try {
    const { bridge, state } = fakeBridge()
    const handle = spawnViaAddon(
      spec({ stdio: { stdin: 'ignore', stdout: { maxBytes: 4, spill: { maxBytes: 4096 } }, stderr: { maxBytes: 4 } } }),
      bridge,
      { spillDir: dir },
    )
    state.onStdout(Buffer.from('abcdefgh'))
    const read = handle.collected.stdout.readFrom(0)
    assert.ok(read.spillPath, 'a spill path is published once the stream overflows')
    assert.equal(readFileSync(read.spillPath, 'utf8'), 'abcdefgh', 'the spill holds the complete stream')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pipe mode exposes a raw Readable carrying the child bytes', async () => {
  const { bridge, state } = fakeBridge()
  const handle = spawnViaAddon(spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }), bridge)
  const chunks = []
  handle.stdout.on('data', (chunk) => { chunks.push(chunk) })
  state.onStdout(Buffer.from('raw bytes'))
  await tick()
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'raw bytes')
})

test('done resolves with the exit code after the drain window', async () => {
  const { bridge, state } = fakeBridge()
  const handle = spawnViaAddon(spec({ graceMs: 20 }), bridge)
  state.onStdout(Buffer.from('late'))
  state.onExit(7)
  const outcome = await handle.done
  assert.deepEqual(outcome, { exitCode: 7, signal: null })
  assert.equal(handle.collected.stdout.readFrom(0).text, 'late', 'output delivered before the drain settles is retained')
})

test('terminate sends SIGTERM and escalates to SIGKILL after the grace', async () => {
  const { bridge } = fakeBridge()
  const signals = []
  const handle = spawnViaAddon(spec({ graceMs: 10 }), bridge, {
    signal: (pid, sig) => { signals.push([pid, sig]) },
  })
  handle.terminate()
  handle.terminate()
  assert.deepEqual(signals, [[4242, 'SIGTERM']], 'terminate is idempotent')
  await new Promise((resolve) => { setTimeout(resolve, 30) })
  assert.deepEqual(signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']], 'the ladder escalates')
})

test('an abort signal starts the same termination ladder', async () => {
  const { bridge } = fakeBridge()
  const controller = new AbortController()
  const signals = []
  spawnViaAddon(spec({ signal: controller.signal, graceMs: 10 }), bridge, {
    signal: (pid, sig) => { signals.push(sig) },
  })
  controller.abort()
  assert.deepEqual(signals, ['SIGTERM'])
})

test('waitForExit resolves once the child exits and honours an abort', async () => {
  const { bridge, state } = fakeBridge()
  const handle = spawnViaAddon(spec({ graceMs: 10 }), bridge)
  const waiting = handle.waitForExit()
  state.onExit(0)
  assert.equal(await waiting, true)
  const controller = new AbortController()
  controller.abort()
  const other = spawnViaAddon(spec({ graceMs: 10 }), fakeBridge().bridge)
  assert.equal(await other.waitForExit(controller.signal), false)
})

test('stdin is refused rather than silently dropped', () => {
  // The addon spawns with stdout/stderr/exit callbacks only. Accepting a stdin
  // disposition would run the command with empty input and let the caller read
  // that as the command's real answer, so the spec is rejected up front.
  const { bridge } = fakeBridge()
  assert.throws(
    () => spawnViaAddon(spec({ stdio: { stdin: 'pipe', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } } }), bridge),
    /stdin is unsupported on Android/,
  )
  assert.throws(
    () => spawnViaAddon(spec({ stdio: { stdin: { data: 'payload\n' }, stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } } }), bridge),
    /stdin is unsupported on Android/,
  )
})

test('the environment is passed as complete KEY=VALUE entries with the scrub applied', () => {
  const { bridge, state } = fakeBridge()
  process.env.DSH_RS_TEST_SECRET = 'leak-me'
  spawnViaAddon(spec({ env: { DSH_RS_TEST_EXTRA: 'kept', DSH_RS_TEST_DROP: undefined } }), bridge)
  delete process.env.DSH_RS_TEST_SECRET
  const entries = state.options.env
  assert.ok(Array.isArray(entries), 'the addon receives an entry list')
  assert.ok(entries.includes('DSH_RS_TEST_EXTRA=kept'), 'an explicit DSH_ entry survives the scrub')
  assert.ok(!entries.some((entry) => entry.startsWith('DSH_RS_TEST_DROP=')), 'an explicit tombstone removes an ambient entry')
  assert.ok(!entries.some((entry) => entry.startsWith('DSH_RS_TEST_SECRET=')), 'a credential-shaped ambient name is scrubbed')
  assert.equal(state.options.cwd, '/data')
})

console.log('')
if (failures.length > 0) {
  console.log(failures.length + ' failed, ' + passed + ' passed')
  process.exit(1)
}
console.log(passed + ' passed')
