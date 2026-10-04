/**
 * Host-side tests for the Android shell executor.
 *
 * The executor's only job is choosing a shell: it must not hardcode `bash`,
 * must prefer a real bash when the device has one, must fall back to `sh`, and
 * must fail loudly (naming what it tried) when neither exists. Everything else —
 * output budgets, spill, SIGTERM→SIGKILL, deadlines — is inherited from the
 * harness executor, so it is deliberately not re-tested here.
 *
 * Run from a runtime-shaped tree so @deepseek-ai/dsh-bash-sandbox resolves.
 */

import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import MkshBashExecutor from '@dsh-android/bash-mksh'

let passed = 0
const failures = []
let chain = Promise.resolve()

/** Register one async test. Serialized: each case swaps the process-wide PATH. */
function test(name, fn) {
  chain = chain.then(fn).then(
    () => { passed++; console.log('  ok  ' + name) },
    (error) => { failures.push(name); console.log('FAIL  ' + name + '\n      ' + String(error && error.message).split('\n')[0]) },
  )
}

/**
 * Run `execute` with a stubbed executeArgv, returning the argv it produced.
 * @param {string} command - the command the tool layer would hand over.
 * @returns {Promise<string[]>} the argv handed to the harness spawn path.
 */
async function argvFor(command) {
  const instance = Object.create(MkshBashExecutor.prototype)
  let captured = null
  instance.executeArgv = (spec, argv) => { captured = argv; return Promise.resolve({ ok: true }) }
  const handle = await instance.execute({ command })
  assert.equal(handle.ok, true, 'execute must resolve with the handle')
  assert.ok(captured, 'executeArgv must be called')
  return captured
}

/**
 * A throwaway PATH dir holding a real executable under each given name.
 *
 * Android resolves bare names with no extension, so the fixture is a bare file.
 * On a Windows host `access(join(dir, 'sh'), X_OK)` legitimately misses, because
 * PATHEXT makes Windows executables `sh.EXE` — so there we name the copies with
 * the extension the resolver will probe. The assertions are about the shell
 * *choice*, which is platform-independent; only the fixture shape is not.
 */
async function pathDir(names) {
  const dir = await mkdtemp(join(tmpdir(), 'bash-mksh-'))
  for (const name of names) {
    const file = join(dir, process.platform === 'win32' ? name + '.exe' : name)
    await copyFile(process.execPath, file)
    await chmod(file, 0o755)
  }
  return dir
}

const originalPath = process.env.PATH

/** Run fn with PATH temporarily replaced, always restoring it. */
async function withPath(dir, fn) {
  const previous = process.env.PATH
  process.env.PATH = dir
  try {
    return await fn()
  } finally {
    process.env.PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('uses sh, never a hardcoded bash, when the device has only sh', async () => {
  await withPath(await pathDir(['sh']), async () => {
    const argv = await argvFor('echo hi && pwd')
    assert.deepEqual(argv, ['sh', '-c', 'echo hi && pwd'])
  })
})

test('prefers bash when the device actually has one', async () => {
  await withPath(await pathDir(['sh', 'bash']), async () => {
    const argv = await argvFor('echo hi')
    assert.equal(argv[0], 'bash')
    assert.equal(argv[1], '-c')
    assert.equal(argv[2], 'echo hi')
  })
})

test('fails loudly and names the candidates when no shell exists', async () => {
  await withPath(await pathDir(['unrelated']), async () => {
    await assert.rejects(() => argvFor('echo hi'), (error) => {
      assert.match(String(error.message), /no usable shell on PATH/)
      assert.match(String(error.message), /bash, sh/, 'must name the candidates it tried')
      return true
    })
  })
})

test('an empty PATH is reported the same way rather than yielding undefined', async () => {
  const previous = process.env.PATH
  process.env.PATH = ''
  try {
    await assert.rejects(() => argvFor('echo hi'), /no usable shell on PATH/)
  } finally {
    process.env.PATH = previous
  }
})

await chain
console.log('\n' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) process.exitCode = 1
