/**
 * Thin, defensive wrapper over the `@rs-cross-spawn/android-arm64` addon.
 *
 * The addon is a native `.node` file that Node's CJS loader `dlopen()`s from the
 * unpacked runtime directory. Two facts shape this module:
 *
 * 1. **Loading is fallible and late.** The addon only exists on Android/arm64,
 *    so it is imported through `createRequire` inside a function rather than at
 *    module scope; a failure must reach the caller as an actionable error
 *    instead of breaking plugin load.
 * 2. **The addon's own errors are terse.** Every failure is re-thrown with the
 *    addon name and the underlying message so a device log names the cause.
 *
 * The addon calls its JS callbacks as `(error, value)` in every case; this
 * bridge drops the error arm because the exit callback owns settlement and an
 * output error has no separate recovery.
 *
 * @module @dsh-android/subprocess-rs/native
 */

import { createRequire } from 'node:module'

/** The published addon specifier, used when a caller passes none. */
export const DEFAULT_ADDON = '@rs-cross-spawn/android-arm64'

/**
 * Load the native addon and bind it to this provider's callback conventions.
 * @param {string} [specifier] - module specifier of the addon; defaults to the published package.
 * @returns {{ path: string, start: (cmd: string, args: readonly string[], options: object, onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void, onExit: (exitCode: number) => void) => { pid: number, kill: () => void } }} the bound bridge.
 * @throws {Error} when the addon cannot be loaded or does not export `spawn`.
 */
export function createNativeBridge(specifier = DEFAULT_ADDON) {
  const require = createRequire(import.meta.url)
  let addon
  let resolved
  try {
    resolved = require.resolve(specifier)
    addon = require(specifier)
  } catch (error) {
    throw new Error(
      'subprocess-rs: cannot load the native addon ' + JSON.stringify(specifier)
      + ' (process.platform=' + process.platform + ', process.arch=' + process.arch + '): '
      + String(error && error.message ? error.message : error),
    )
  }
  if (typeof addon.spawn !== 'function') {
    throw new Error('subprocess-rs: the native addon ' + JSON.stringify(specifier) + ' does not export spawn()')
  }
  return {
    path: resolved,
    start(cmd, args, options, onStdout, onStderr, onExit) {
      return addon.spawn(
        cmd,
        [...args],
        options,
        (_error, chunk) => { if (chunk !== undefined && chunk !== null) onStdout(chunk) },
        (_error, chunk) => { if (chunk !== undefined && chunk !== null) onStderr(chunk) },
        (_error, code) => { onExit(typeof code === 'number' ? code : -1) },
      )
    },
  }
}
