#!/usr/bin/env node
/**
 * Fetch and verify the `@rs-cross-spawn/android-arm64` native addon.
 *
 * The addon is a 645 KB prebuilt `.node` file; it is vendored into the provider
 * package so the Android build never depends on the network at pack time. Run
 * this script when the upstream version changes.
 *
 * Verification is by the npm registry's published integrity hash, pinned here —
 * a native addon executes in-process, so an unverified download is not
 * acceptable for a build input.
 *
 * Usage: node scripts/fetch-addon.mjs
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const VERSION = '0.1.4'
/** sha512 integrity published by npm for @rs-cross-spawn/android-arm64@0.1.4. */
const INTEGRITY = 'sha512-CKkln7nsFKkj3NV9Whhq7LvWt8nl0owRx73htWfzjmQCx2CnY2b4dVCnV/edeL9cDYMMj2RLuLohB3DGjzEqkg=='

const CACHE = path.join(ROOT, 'build', `rs-cross-spawn-${VERSION}.tgz`)
const DEST = path.join(ROOT, 'plugins', 'subprocess-rs', 'node_modules', '@rs-cross-spawn', 'android-arm64')

/**
 * Run npm. On Windows npm is a `.cmd` shim, which Node refuses to spawn
 * directly (EINVAL), so it goes through cmd.exe there.
 * @param {string[]} args - npm arguments.
 * @param {string} cwd - working directory.
 * @returns {void}
 */
function execNpm(args, cwd) {
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'npm', ...args], { stdio: 'inherit', cwd })
    return
  }
  execFileSync('npm', args, { stdio: 'inherit', cwd })
}

function sha512(file) {
  const digest = createHash('sha512').update(fs.readFileSync(file)).digest('base64')
  return 'sha512-' + digest
}

function main() {
  if (!fs.existsSync(CACHE) || sha512(CACHE) !== INTEGRITY) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true })
    console.log(`downloading @rs-cross-spawn/android-arm64@${VERSION}…`)
    execNpm(['pack', `@rs-cross-spawn/android-arm64@${VERSION}`, '--pack-destination', path.dirname(CACHE)], path.dirname(CACHE))
    const packed = path.join(path.dirname(CACHE), `rs-cross-spawn-android-arm64-${VERSION}.tgz`)
    if (!fs.existsSync(packed)) throw new Error(`npm pack produced no tarball at ${packed}`)
    fs.renameSync(packed, CACHE)
  }
  const actual = sha512(CACHE)
  if (actual !== INTEGRITY) {
    throw new Error(`integrity mismatch for ${CACHE}
  expected ${INTEGRITY}
  actual   ${actual}`)
  }
  console.log('integrity verified')

  fs.rmSync(DEST, { recursive: true, force: true })
  fs.mkdirSync(DEST, { recursive: true })
  // The AGP/CMake toolchains are not available for a .node file, and the host is
  // Windows: unpack with the tar that ships with the dsh-desktop runtime.
  const req = createRequire(path.join(ROOT, 'scripts', 'package.json'))
  void req
  execFileSync('tar', ['-xzf', CACHE, '-C', DEST, '--strip-components=1'], { stdio: 'inherit' })
  const addon = path.join(DEST, 'rs-cross-spawn.node')
  if (!fs.existsSync(addon)) throw new Error(`unpacked tarball has no rs-cross-spawn.node in ${DEST}`)
  console.log(`vendored ${addon} (${fs.statSync(addon).size} bytes)`)
}

main()
