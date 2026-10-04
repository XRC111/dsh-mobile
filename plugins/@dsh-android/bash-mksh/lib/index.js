/**
 * Android shell executor for DSH.
 *
 * Why this package exists: the tool layer's bash executor ships a hardcoded
 * `['bash', '-c', command]` argv (@deepseek-ai/dsh-bash-local, line ~142), and
 * its sandboxing subclass inherits that argv unchanged. Android ships no `bash`
 * at all — the system shell is mksh, reachable as `/system/bin/sh` — so every
 * `bash` tool call fails with executable-not-found.
 *
 * This executor changes exactly one thing: the shell binary. It reuses
 * `LocalBashExecutor.executeArgv`, so output budgets, spill files, the managed
 * SIGTERM→SIGKILL ladder, deadline handling and result decoration all remain the
 * harness's own code. The `danger-full-access` branch is inherited from
 * `SandboxBashExecutor`, which delegates to `super.execute()` — so overriding
 * that one method redirects both the confined and the unconfined path without
 * duplicating any sandbox logic.
 *
 * The tool layer (@deepseek-ai/dsh-tool-bash) is unchanged: it talks to
 * `ctx.shell`, and this class registers as `ctx.shell`, so the swap is one row
 * in the profile patch.
 *
 * @module @dsh-android/bash-mksh
 */

import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

/**
 * Shells to try, in order. `sh` is resolved through the subprocess seam's own
 * PATH lookup, so a device that later installs a real bash still prefers it.
 * @type {readonly string[]}
 */
const SHELL_CANDIDATES = ['bash', 'sh']

/**
 * Whether an executable of that name exists on PATH.
 *
 * @param {string} name - bare executable name.
 * @returns {Promise<boolean>} true when PATH resolution finds it.
 */
async function hasExecutable(name) {
  const { access, constants } = await import('node:fs/promises')
  const { join, delimiter } = await import('node:path')
  // PATHEXT matters only off-Android; on POSIX every candidate is bare.
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      try {
        await access(join(dir, name + suffix), constants.X_OK)
        return true
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false
}

/**
 * Resolve the shell this device should run commands with.
 *
 * @returns {Promise<string>} an executable name available on PATH.
 * @throws when no candidate is present, naming what was tried.
 */
async function resolveShell() {
  for (const candidate of SHELL_CANDIDATES) {
    if (await hasExecutable(candidate)) return candidate
  }
  throw new Error(
    'bash-mksh: no usable shell on PATH (tried ' + SHELL_CANDIDATES.join(', ')
    + '). Android normally provides /system/bin/sh; check that PATH still contains it.',
  )
}

/**
 * Bash executor that runs commands with the device's real shell.
 *
 * `sandboxMode` is inherited: on Android the deployment pins
 * `danger-full-access` (no bwrap/landlock exists here), so the inherited sandbox
 * branch delegates straight to this `execute`.
 */
export class MkshBashExecutor extends SandboxBashExecutor {
  /**
   * Run `spec.command` through the resolved shell instead of a hardcoded bash.
   *
   * @param {object} spec - resolved execution settings from the tool layer.
   * @returns {Promise<object>} the live execution handle, as the seam requires.
   */
  async execute(spec) {
    const shell = await resolveShell()
    return this.executeArgv(spec, [shell, '-c', spec.command])
  }
}

export default MkshBashExecutor
