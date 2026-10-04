/**
 * Android subprocess Service Provider for DSH, backed by the
 * `@rs-cross-spawn/android-arm64` native addon.
 *
 * Why this package exists: `@deepseek-ai/dsh-subprocess-local` reaches the
 * platform through `node:child_process`, whose POSIX path ends in
 * `posix_spawn`/`execve`. An Android app process may not do that for binaries in
 * its home directory: Android 10 removed the execute permission from
 * `/data/user/0/<pkg>/files` entirely, so a direct `execve()` on anything the
 * harness unpacked there fails regardless of the file mode.
 *
 * The addon reaches the same syscall family a different way — it is a Rust
 * `std::process::Command` implementation, i.e. `fork()` + `execvp()` (verified by
 * symbol analysis of `rs-cross-spawn.node`; it does **not** use `dlopen()`), and it
 * carries no libuv, so it loads into an embedded runtime that has no `node`
 * executable. Being plain fork+exec, it therefore does *not* defeat the app-home
 * exec ban: only binaries outside the app directory (system partition binaries
 * such as `/system/bin/sh` and toybox applets) are reachable. The win is that
 * this Provider is the seam-conforming implementation, so consumers load and
 * report precisely this limitation instead of tripping over a missing `node-pty`.
 *
 * The service registers as `ctx.subprocess` exactly like the local provider,
 * so every consumer (the bash executor, the LSP host, PTC, subagents) is
 * unchanged; the swap is one row in the profile patch.
 *
 * @module @dsh-android/subprocess-rs
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { SubprocessExecutableNotFoundError, SubprocessRuntime, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { createNativeBridge, DEFAULT_ADDON } from './native.js'
import { spawnViaAddon } from './spawn.js'

export { AndroidSubprocessHandle, environmentEntries, validateSpec } from './spawn.js'
export { createNativeBridge, DEFAULT_ADDON } from './native.js'

/**
 * Android subprocess service: the same seam semantics as the local provider,
 * implemented over the fork+execvp addon instead of `node:child_process`.
 *
 * Provider-specific facts a consumer must know:
 * - **No stdin.** The addon's `spawn` takes stdout, stderr, and exit callbacks
 *   only and publishes no stdin writer, so any spec whose `stdio.stdin` is not
 *   `'ignore'` is refused rather than silently downgraded (see `validateSpec`).
 *   The bash tool never sets stdin — its comment records that a model wanting
 *   stdin uses shell syntax — so the tool surface is unaffected.
 * - **No separate control channel.** A spec requesting
 *   `stdio.control === 'pipe'` is likewise refused. The SSH helper, the one
 *   consumer that requests it, is not reachable on Android.
 * - **No terminals.** Android has no usable PTY for an app process and the
 *   addon cannot allocate one, so `spawnTerminal` rejects and the terminal
 *   surface stays empty.
 * - **Signalling is whole-process.** `terminate()` sends SIGTERM to the child
 *   pid and escalates to SIGKILL after `graceMs`; the addon cannot signal a
 *   process group, so a descendant that outlives its parent is not reaped.
 */
export class AndroidSubprocessRuntime extends SubprocessRuntime {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the owning plugin context.
   */
  constructor(ctx) {
    super(ctx)
    /** Live handles retained for disposal; each removes itself at managed-range exit. */
    this.live = new Set()
    /** Test seam: replaces the addon module specifier. */
    this.internals = {}
    /** @type {ReturnType<typeof createNativeBridge> | undefined} */
    this.bridge = undefined
    this.reportSpillFailure = (error, label) => {
      this.ctx.logger.error(
        'subprocess-rs could not write the complete ' + label
        + ' stream to its spill file; the result keeps only the in-memory tail and reports no full-output path.',
        error,
      )
    }
    ctx.effect(() => {
      const onHostExit = () => {
        for (const handle of this.live) {
          try {
            handle.terminate()
          } catch {
            // Host exit cannot await or report one target; continue with the rest.
          }
        }
      }
      process.prependListener('exit', onHostExit)
      return async () => {
        process.off('exit', onHostExit)
        await this.disposeManagedProcesses()
      }
    }, 'android subprocess teardown')
  }

  /**
   * Terminate and join every live managed process.
   * @returns {Promise<void>} resolves once every retained handle settled.
   */
  async disposeManagedProcesses() {
    const pending = []
    for (const handle of this.live) {
      handle.terminate()
      pending.push(Promise.all([handle.done.catch(() => {}), handle.waitForExit()]).then(() => {
        this.live.delete(handle)
      }))
    }
    const outcomes = await Promise.allSettled(pending)
    const failures = []
    for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'android subprocess teardown failed')
  }

  /**
   * The native bridge, loaded on first use so a broken addon cannot break plugin load.
   * @returns {ReturnType<typeof createNativeBridge>} the loaded bridge.
   */
  native() {
    this.bridge ??= createNativeBridge(this.internals.addon ?? DEFAULT_ADDON)
    return this.bridge
  }

  /**
   * Resolve one configured executable in this execution world: absolute paths
   * are verified, bare names are looked up on the scrubbed `PATH`.
   * @param {string} command - absolute executable path or bare PATH name.
   * @param {Readonly<Record<string, string>>} [env] - explicit environment entries used for lookup.
   * @param {AbortSignal} [signal] - aborts local lookup.
   * @returns {Promise<string>} the canonical executable path.
   */
  async resolveExecutable(command, env, signal) {
    if (command.length === 0) throw new Error('subprocess-rs: executable must be non-empty')
    signal?.throwIfAborted()
    if (!command.includes('/')) {
      const path = childEnv(env).PATH ?? ''
      for (const directory of path.split(':')) {
        if (directory.length === 0) continue
        const candidate = directory.endsWith('/') ? directory + command : directory + '/' + command
        if (await isExecutableFile(candidate)) return candidate
      }
      signal?.throwIfAborted()
      throw new SubprocessExecutableNotFoundError(
        'subprocess-rs: command ' + JSON.stringify(command) + ' was not found on PATH',
      )
    }
    if (!command.startsWith('/')) {
      throw new Error(
        'subprocess-rs: command ' + JSON.stringify(command)
        + ' is a relative path; use an absolute path or a bare PATH name',
      )
    }
    if (await isExecutableFile(command)) return command
    signal?.throwIfAborted()
    throw new SubprocessExecutableNotFoundError(
      'subprocess-rs: command ' + JSON.stringify(command) + ' is not an executable file',
    )
  }

  /**
   * Inspect shell-selection facts. Android has no login shell an app process
   * may start, so only the platform fact is reported.
   * @param {AbortSignal} [signal] - cancellation of environment inspection.
   * @returns {Promise<{ platform: 'posix' }>} the POSIX platform fact.
   */
  async terminalEnvironment(signal) {
    signal?.throwIfAborted()
    return { platform: 'posix' }
  }

  /**
   * Start one managed child process from a fully-specified spec.
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec - argv, directory, stdio dispositions, grace, cancellation, environment.
   * @returns {import('@deepseek-ai/dsh-subprocess').SubprocessHandle} the live process handle.
   * @throws {Error} synchronously when the spec is invalid, the control channel is requested, or the addon cannot load.
   */
  spawn(spec) {
    const handle = spawnViaAddon(spec, this.native(), { onSpillFailure: this.reportSpillFailure })
    this.live.add(handle)
    const release = () => handle.waitForExit().then(() => { this.live.delete(handle) })
    void handle.done.then(release, release).catch(() => {})
    return handle
  }

  /**
   * Allocate a terminal process session.
   * @param {{ signal?: AbortSignal }} spec - fully specified terminal spawn.
   * @returns {Promise<never>} never; Android has no PTY this provider can allocate.
   */
  async spawnTerminal(spec) {
    spec.signal?.throwIfAborted()
    throw new Error(
      'subprocess-rs: terminal allocation is unavailable on Android (no PTY backend); the terminal surface stays empty',
    )
  }
}

/**
 * Build the child environment: explicit entries over the scrubbed parent base.
 * @param {Readonly<NodeJS.ProcessEnv>} [extra] - explicit caller entries and tombstones.
 * @returns {NodeJS.ProcessEnv} the merged environment used for executable lookup.
 */
function childEnv(extra) {
  const merged = { ...scrubbedParentEnv() }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}

/**
 * Whether `path` names an executable regular file.
 * @param {string} path - candidate executable path.
 * @returns {Promise<boolean>} true when the path is a file this process may execute.
 */
async function isExecutableFile(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export default AndroidSubprocessRuntime
