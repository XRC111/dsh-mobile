/**
 * One managed process for the Android provider: argv validation, stdio
 * dispositions, the outcome promise, and the TERM-then-KILL termination ladder.
 *
 * The addon gives a narrower substrate than `node:child_process` — no streams,
 * no signal delivery beyond a single `kill()`, no process groups — so this file
 * owns what the local provider gets from Node: it presents seam-shaped streams
 * over the native callbacks and runs the escalation ladder itself.
 *
 * Managed range: the child pid alone. The addon cannot signal a process group,
 * so a descendant that outlives its parent is outside what this handle can
 * observe or terminate.
 *
 * @module @dsh-android/subprocess-rs/spawn
 */

import { PassThrough } from 'node:stream'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector, defaultSpillDir } from './output.js'

/** Node's timer ceiling; a larger grace would overflow `setTimeout`. */
const MAX_TIMER_DELAY_MS = 2147483647

/**
 * Upper bound on the post-exit drain window. The addon delivers output through
 * a thread-safe function, so its reader threads can still be handing over bytes
 * after the exit callback fires; a short bounded wait keeps the tail rather than
 * truncating it, and never outlives the caller's own grace.
 */
const MAX_DRAIN_MS = 250

/**
 * Validate the synchronous portion of one spawn request.
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec - exact target request.
 * @returns {void}
 * @throws {Error} when grace, cancellation, argv, or an unsupported stdio channel is requested.
 */
export function validateSpec(spec) {
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error('subprocess-rs graceMs must be a positive finite number no greater than ' + MAX_TIMER_DELAY_MS)
  }
  if (spec.signal?.aborted) {
    let reason = 'aborted'
    try {
      reason = String(spec.signal.reason ?? reason)
    } catch {
      // Arbitrary caller-owned reasons cannot escape the stable Error boundary.
    }
    throw new Error('aborted before spawn: ' + reason)
  }
  const [program] = spec.argv
  if (program === undefined || program.length === 0) {
    throw new Error('invalid argv: expected a non-empty program name at argv[0]')
  }
  if (spec.stdio.control === 'pipe') {
    throw new Error(
      'subprocess-rs: stdio.control is unsupported on Android; the native addon exposes stdout and stderr only',
    )
  }
  if (spec.stdio.stdin !== 'ignore') {
    // The addon's spawn takes stdout, stderr, and exit callbacks only — it
    // publishes no stdin writer. Refusing beats accepting bytes that would be
    // silently dropped: a consumer that asked for stdin would otherwise read a
    // command's empty-input result as the command's real answer.
    throw new Error(
      'subprocess-rs: stdin is unsupported on Android; the native addon spawns without a stdin channel',
    )
  }
}

/**
 * Build the addon's complete environment: `KEY=VALUE` entries with NUL-bearing
 * names or values dropped, since the addon rejects the whole launch on a NUL
 * and a NUL can only come from a malformed caller entry.
 * @param {Readonly<NodeJS.ProcessEnv>} [extra] - explicit caller entries merged over the scrubbed parent base.
 * @returns {string[]} the entry list handed to the addon.
 */
export function environmentEntries(extra) {
  const merged = { ...scrubbedParentEnv() }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  const entries = []
  for (const [key, value] of Object.entries(merged)) {
    if (key.length === 0 || key.includes('\u0000') || value.includes('\u0000')) continue
    entries.push(key + '=' + value)
  }
  return entries
}

/**
 * A live process backed by the native addon. Output arrives through native
 * callbacks and is fanned out to the disposition the spec requested: a raw
 * `Readable` for `'pipe'`, this process's own descriptor for `'inherit'`, and a
 * bounded collector for a collect object.
 */
export class AndroidSubprocessHandle {
  /**
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec - the validated spawn request.
   * @param {{ onSpillFailure?: (error: unknown, label: string) => void, spillDir?: string, sleep?: (ms: number) => Promise<void>, signal?: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void }} [internals] - spill, sleep, and signal overrides.
   */
  constructor(spec, internals = {}) {
    this.spec = spec
    this.internals = internals
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdoutInherit = outMode === 'inherit'
    this.stderrInherit = errMode === 'inherit'
    this.stdoutCollector = collectorFor(outMode, 'stdout', internals)
    this.stderrCollector = collectorFor(errMode, 'stderr', internals)
    this.stdoutPipe = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderrPipe = errMode === 'pipe' ? new PassThrough() : undefined
    /** Present iff the spec requested `stdout: 'pipe'`. */
    this.stdout = this.stdoutPipe
    /** Present iff the spec requested `stderr: 'pipe'`. */
    this.stderr = this.stderrPipe
    /** Always absent: the addon publishes no stdin channel (see `validateSpec`). */
    this.stdin = undefined
    /** Always absent: the addon exposes no separate control channel. */
    this.control = undefined
    /** Offset-based readers for collect-mode streams. */
    this.collected = {
      ...this.stdoutCollector !== undefined ? { stdout: this.stdoutCollector } : {},
      ...this.stderrCollector !== undefined ? { stderr: this.stderrCollector } : {},
    }
    /** @type {Promise<import('@deepseek-ai/dsh-subprocess').SubprocessOutcome>} */
    this.done = new Promise((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    // A rejection with no caller-side handler must not become an unhandled
    // rejection inside the embedded runtime; consumers attach their own.
    void this.done.catch(() => {})
    /** @type {{ pid: number, kill: () => void } | undefined} */
    this.child = undefined
    this.terminated = false
    this.settled = false
    this.exited = false
    /** @type {Array<() => void>} */
    this.exitWaiters = []
    spec.signal?.addEventListener('abort', () => { this.terminate() }, { once: true })
  }

  /**
   * Attach the live native child; called immediately after a successful start.
   * @param {{ pid: number, kill: () => void }} child - the addon's child handle.
   * @returns {void}
   */
  attach(child) {
    this.child = child
  }

  /**
   * Ingest one stdout chunk from the native callback.
   * @param {Buffer} chunk - bytes delivered by the addon.
   * @returns {void}
   */
  onStdout(chunk) {
    if (this.stdoutCollector !== undefined) this.stdoutCollector.push(chunk)
    else if (this.stdoutPipe !== undefined) this.stdoutPipe.write(chunk)
    else if (this.stdoutInherit) process.stdout.write(chunk)
  }

  /**
   * Ingest one stderr chunk from the native callback.
   * @param {Buffer} chunk - bytes delivered by the addon.
   * @returns {void}
   */
  onStderr(chunk) {
    if (this.stderrCollector !== undefined) this.stderrCollector.push(chunk)
    else if (this.stderrPipe !== undefined) this.stderrPipe.write(chunk)
    else if (this.stderrInherit) process.stderr.write(chunk)
  }

  /**
   * Record the child's exit and publish the outcome once the drain window
   * closes, so output still in flight through the addon's thread-safe function
   * reaches the collectors and pipes first.
   * @param {number} exitCode - the code the addon reported.
   * @returns {void}
   */
  onExit(exitCode) {
    if (this.settled || this.exited) return
    this.exited = true
    const wantsOutput = this.stdoutCollector !== undefined || this.stderrCollector !== undefined
      || this.stdoutPipe !== undefined || this.stderrPipe !== undefined
    const drainMs = wantsOutput ? Math.min(this.spec.graceMs, MAX_DRAIN_MS) : 0
    if (drainMs === 0) { this.finish(exitCode); return }
    // Deliberately a ref'd timer: the outcome promise has not settled yet, so the
    // handle is still live work. Unref'ing it let the runtime exit with `done`
    // forever pending whenever nothing else was queued.
    setTimeout(() => { this.finish(exitCode) }, drainMs)
  }

  /**
   * Publish a provider failure: the child never started, so no output exists.
   * @param {unknown} error - the native start failure.
   * @returns {void}
   */
  fail(error) {
    if (this.settled) return
    this.settled = true
    this.releaseStreams()
    this.settle.reject(error)
  }

  /**
   * Begin the documented termination ladder: SIGTERM now, SIGKILL after
   * `graceMs`. Idempotent and a no-op once the child has exited.
   * @returns {void}
   */
  terminate() {
    if (this.terminated || this.exited) return
    this.terminated = true
    this.signalChild('SIGTERM')
    const sleep = this.internals.sleep ?? ((ms) => sleepMs(ms))
    void sleep(this.spec.graceMs).then(() => {
      if (!this.exited) this.signalChild('SIGKILL')
    }, () => {
      // A cancelled sleep only means the ladder was torn down with the handle.
    })
  }

  /**
   * Deliver one signal to the child pid, tolerating the exit race. `process.kill`
   * reaches the same syscall the addon's own `kill()` uses, so a signal the
   * addon cannot express (SIGKILL) is still deliverable.
   * @param {'SIGTERM' | 'SIGKILL'} sig - the signal to deliver.
   * @returns {void}
   */
  signalChild(sig) {
    const child = this.child
    if (child === undefined) return
    if (this.internals.signal !== undefined) {
      this.internals.signal(child.pid, sig)
      return
    }
    try {
      process.kill(child.pid, sig)
    } catch {
      try {
        child.kill()
      } catch {
        // The child already exited; teardown stays idempotent.
      }
    }
  }

  /**
   * Wait until the managed range is empty.
   * @param {AbortSignal} [signal] - optional bound for the wait.
   * @returns {Promise<boolean>} true when the range is empty, false when the signal aborted first.
   */
  async waitForExit(signal) {
    if (this.exited && this.settled) return true
    const exited = new Promise((resolve) => { this.exitWaiters.push(() => { resolve(true) }) })
    if (signal === undefined) return exited
    if (signal.aborted) return false
    const aborted = new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve(false) }, { once: true })
    })
    return Promise.race([exited, aborted])
  }

  /**
   * Seal collectors, end pipes, and publish the outcome.
   * @param {number} exitCode - the child's exit code.
   * @returns {void}
   */
  finish(exitCode) {
    if (this.settled) return
    this.settled = true
    this.releaseStreams()
    this.settle.resolve({ exitCode, signal: null })
  }

  /**
   * End every caller-facing stream exactly once and wake pending waits.
   * @returns {void}
   */
  releaseStreams() {
    this.stdoutCollector?.seal()
    this.stderrCollector?.seal()
    this.stdoutPipe?.end()
    this.stderrPipe?.end()
    for (const waiter of this.exitWaiters.splice(0)) waiter()
  }
}

/**
 * Build the collector for one collect-mode disposition, if the spec asked for one.
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessOutputMode} mode - the stream's disposition.
 * @param {string} label - stream label for spill naming and failure reports.
 * @param {object} internals - spill overrides.
 * @returns {OutputCollector | undefined} the collector, or undefined for a non-collect disposition.
 */
function collectorFor(mode, label, internals) {
  if (mode === 'pipe' || mode === 'inherit') return undefined
  return new OutputCollector(mode.maxBytes, label, mode.spill === undefined ? undefined : {
    maxBytes: mode.spill.maxBytes,
    dir: internals.spillDir ?? defaultSpillDir(),
    onFailure: internals.onSpillFailure ?? reportSpillFailureToStderr,
  })
}

/**
 * The stderr reporter used when no owner supplies one.
 * @param {unknown} error - the spill failure.
 * @param {string} label - the failed stream label.
 * @returns {void}
 */
function reportSpillFailureToStderr(error, label) {
  process.stderr.write(
    'subprocess-rs: ' + label + ' spill failed; only the in-memory tail is retained: ' + String(error) + '\n',
  )
}

/**
 * Start one process through the native addon and bind the seam lifecycle.
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec - fully resolved argv, cwd, stdio, grace, cancellation, environment.
 * @param {{ start: Function, path: string }} bridge - the loaded addon bridge.
 * @param {object} [internals] - spill and signalling overrides.
 * @returns {AndroidSubprocessHandle} the live handle.
 * @throws {Error} synchronously only for an invalid spec; a native start failure rejects `done`.
 */
export function spawnViaAddon(spec, bridge, internals = {}) {
  validateSpec(spec)
  const [program, ...args] = spec.argv
  const handle = new AndroidSubprocessHandle(spec, internals)
  try {
    const child = bridge.start(
      program,
      args,
      { cwd: spec.cwd, env: environmentEntries(spec.env) },
      (chunk) => { handle.onStdout(chunk) },
      (chunk) => { handle.onStderr(chunk) },
      (code) => { handle.onExit(code) },
    )
    handle.attach(child)
  } catch (error) {
    // A start failure is a provider rejection, not a synchronous throw: the
    // seam returns a live handle and reports failure through `done`, which is
    // also how `node:child_process` reports ENOENT.
    handle.fail(error)
  }
  return handle
}
