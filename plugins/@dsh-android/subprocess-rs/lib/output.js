/**
 * Bounded output tails and private spill files for the Android provider.
 *
 * Semantics are the seam's, not this file's invention: a collect-mode reader is
 * offset-based and non-consuming, overflow keeps the TAIL, and an optional
 * spill file carries the COMPLETE stream so a caller can recover the head. The
 * local provider's collector implements the same rules; this one is written
 * against the seam alone so the Android provider does not depend on the
 * package it replaces.
 *
 * Spilling is best-effort by design: `push()` runs inside a native callback,
 * where a thrown filesystem error would become an uncaught exception in the
 * embedded runtime. A spill failure is reported once and collection continues
 * with the in-memory tail.
 *
 * @module @dsh-android/subprocess-rs/output
 */

import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Receives one spill failure so the owner can log it through its own logger.
 * @typedef {(error: unknown, label: string) => void} SpillFailureReporter
 */

let spillDirCache

/**
 * The private (0700) per-process spill directory under the platform temp dir,
 * created lazily. Android has no `/tmp`, so this relies on `TMPDIR` being set
 * by the launcher; a misconfigured temp root surfaces as a reported spill
 * failure rather than a crash.
 * @returns {string} the directory that receives spill files.
 */
export function defaultSpillDir() {
  if (spillDirCache === undefined) {
    const dir = join(tmpdir(), 'dsh-subprocess-rs-' + process.pid + '-' + randomBytes(4).toString('hex'))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    spillDirCache = dir
  }
  return spillDirCache
}

/**
 * Collects one stream into a bounded in-memory tail, optionally mirroring the
 * complete stream into a spill file once the tail overflows.
 */
export class OutputCollector {
  /**
   * @param {number} maxBytes - in-memory tail cap in bytes.
   * @param {string} label - stream label used in spill file names and failure reports.
   * @param {{ maxBytes: number, dir: string, onFailure: SpillFailureReporter } | undefined} spill - spill storage; omit for tail-only collection.
   */
  constructor(maxBytes, label, spill) {
    this.maxBytes = maxBytes
    this.label = label
    this.spill = spill
    /** @type {Buffer[]} */
    this.chunks = []
    this.bytes = 0
    this.dropped = false
    this.total = 0
    /** @type {number | undefined} */
    this.spillFd = undefined
    /** @type {string | undefined} */
    this.spillFile = undefined
    this.spillDisabled = spill === undefined
  }

  /**
   * Ingest one chunk, counting it toward the whole-stream total and trimming
   * the retained tail back to the cap.
   * @param {Buffer} chunk - raw bytes from one native callback.
   * @returns {void}
   */
  push(chunk) {
    this.total += chunk.length
    const spill = this.spill
    if (spill !== undefined && !this.spillDisabled && (this.bytes + chunk.length > this.maxBytes || this.spillFd !== undefined)) {
      this.spillAll(spill, chunk)
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        // Trim the head so the retained window is byte-exact at the cap: a
        // diagnostic tail must hold the LAST maxBytes however the stream was chunked.
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /**
   * Open the spill lazily and append the chunk plus any already-collected head.
   * @param {{ maxBytes: number, dir: string, onFailure: SpillFailureReporter }} spill - spill storage.
   * @param {Buffer} chunk - the chunk that overflowed the tail.
   * @returns {void}
   */
  spillAll(spill, chunk) {
    if (this.total > spill.maxBytes) {
      this.discardSpill()
      return
    }
    try {
      if (this.spillFd === undefined) {
        // Random suffix + 'wx' + 0600: the spill path is unguessable and an
        // existing entry (planted or leftover) fails the open instead of being
        // written through, so discardSpill never unlinks a file this process
        // did not create.
        const file = join(
          spill.dir,
          'dsh-subprocess-rs-' + process.pid + '-' + (++spillCounter) + '-' + randomBytes(6).toString('hex') + '-' + this.label + '.log',
        )
        const fd = openSync(file, 'wx', 0o600)
        this.spillFile = file
        this.spillFd = fd
        for (const prior of this.chunks) writeSync(fd, prior)
      }
      writeSync(this.spillFd, chunk)
    } catch (error) {
      this.discardSpill()
      try {
        spill.onFailure(error, this.label)
      } catch (reporterFailure) {
        // The reporter runs inside a native callback too; a failing logger must
        // not become the uncaught exception this path exists to prevent.
        process.stderr.write('subprocess-rs: spill failure reporter threw: ' + String(reporterFailure) + '\n')
      }
    }
  }

  /**
   * Stop spilling and remove the file once it can no longer hold the complete stream.
   * @returns {void}
   */
  discardSpill() {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Retain the descriptor so seal() can retry the failed close.
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // A failed unlink leaves at most maxBytes behind, never an unbounded file.
      }
    }
  }

  /**
   * Incremental read in whole-stream byte coordinates.
   * @param {number} fromByte - whole-stream offset to resume from (0 for the first read).
   * @returns {{ text: string, nextOffset: number, lossy: boolean, spillPath?: string }} the delta text, the next offset, the lossy flag, and the spill path when one exists.
   */
  readFrom(fromByte) {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }

  /**
   * Close the spill file once the stream has ended. A failed close stops
   * advertising the path (the file may be missing its tail) while in-memory
   * reads keep working. Idempotent.
   * @returns {void}
   */
  seal() {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      this.spillFile = undefined
    }
    this.spillFd = undefined
  }
}

let spillCounter = 0
