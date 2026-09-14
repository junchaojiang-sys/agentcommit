import { lstatSync, readdirSync, readlinkSync, type BigIntStats } from 'node:fs'
import path from 'node:path'
import type { CasStore, FileIdentity } from '../cas/types.js'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import type { IgnoreEngine } from './ignore.js'
import {
  ALL_UNPROTECTED_REASONS,
  type FileRecord,
  type IgnoredBoundary,
  type ScanStatistics,
  type UnprotectedReason,
} from './types.js'

export interface ScanOptions {
  /** Absolute workspace root; the scan never escapes it. */
  root: string
  /** Engine built from the FROZEN protection policy (Blocker 1) — never re-read disk. */
  ignore: IgnoreEngine
  /** Effective per-file cap (OQ-06); files strictly above it are unprotected. */
  maxFileSizeBytes: number
  /** Protected file content is streamed into this store during the scan. */
  cas: CasStore
  /** Stable-read attempts before failing closed (initial try + retries). */
  maxStableReadRetries?: number
}

export interface ScanResult {
  files: FileRecord[]
  /** Ignored protection boundaries (roots + rules; descendants not enumerated). */
  ignored: IgnoredBoundary[]
  stats: ScanStatistics
}

function emptyStats(): ScanStatistics {
  return {
    scannedEntries: 0,
    ignoredEntries: 0,
    protectedFiles: 0,
    symlinks: 0,
    unprotected: 0,
    unreadableEntries: 0,
    byReason: {},
  }
}

function bumpReason(stats: ScanStatistics, reason: UnprotectedReason): void {
  const current = stats.byReason[reason]
  stats.byReason[reason] = (current ?? 0) + 1
}

function countUnprotected(stats: ScanStatistics, reason: UnprotectedReason): void {
  stats.unprotected++
  bumpReason(stats, reason)
}

/**
 * Deterministic workspace scan (docs/TRANSACTION_MODEL §2, STORAGE §1).
 *
 * Safety rules:
 * - Every entry's type comes from lstat (never follows known symlinks/junctions).
 *   Unknown Windows reparse-point behavior remains a P4 hardening item.
 * - Ignored entries are disclosed as IgnoredBoundary roots + matched rules
 *   (builtin vs .agentcommitignore); pruned subtrees are NOT enumerated (Blocker 3).
 * - Regular files are read through a stable-read guard: identity (size, mtime,
 *   ino, dev) captured before the read must match after the read; otherwise the
 *   read result is discarded and retried up to maxStableReadRetries; a
 *   persistently changing file FAILS CLOSED with FILE_CHANGED_DURING_SNAPSHOT
 *   (Blocker 2). V0.1 has no atomic workspace snapshot: mid-read mutation is
 *   detected for the paths it can see, and this guard does not claim to remove
 *   every concurrency/TOCTOU risk.
 * - CAS integrity failures (BLOB_CORRUPT) propagate — a scan must not succeed
 *   over a corrupt baseline (Blocker 4).
 * - Output is sorted by path (code-unit order) for determinism.
 */
export async function scanWorkspace(options: ScanOptions): Promise<ScanResult> {
  const root = path.resolve(options.root)
  const maxRetries = options.maxStableReadRetries ?? 2
  const files: FileRecord[] = []
  const ignored = new Map<string, IgnoredBoundary>()
  const stats = emptyStats()

  await walk(root, '')
  files.sort(byPath)
  return {
    files,
    ignored: [...ignored.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    stats,
  }

  function byPath(a: FileRecord, b: FileRecord): number {
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  }

  async function walk(absDir: string, relDir: string): Promise<void> {
    let names: string[]
    try {
      // Sorted here AND at output: deterministic traversal, deterministic records.
      names = readdirSync(absDir).sort()
    } catch (error) {
      if (relDir === '') {
        throw new AgentCommitError(
          ErrorCodes.UnsupportedFile,
          `Workspace root is not readable: ${absDir}`,
          { cause: error },
        )
      }
      stats.unreadableEntries++
      return
    }

    for (const name of names) {
      stats.scannedEntries++
      const rel = relDir === '' ? name : `${relDir}/${name}`
      const abs = path.join(absDir, name)

      // lstat is the single source of truth — it never follows symlinks/junctions.
      let st: BigIntStats | undefined
      try {
        st = lstatSync(abs, { bigint: true })
      } catch {
        st = undefined
      }
      const isDir = st !== undefined && st.isDirectory()
      const boundary = options.ignore.matchIgnored(rel, isDir)
      if (boundary !== null) {
        stats.ignoredEntries++
        ignored.set(`${boundary.path}|${boundary.rule}|${boundary.source}`, boundary)
        continue
      }

      if (st === undefined) {
        files.push({
          path: rel,
          type: 'file',
          size: 0,
          protected: false,
          reasonUnprotected: 'inaccessible',
        })
        countUnprotected(stats, 'inaccessible')
        stats.unreadableEntries++
        continue
      }

      if (st.isSymbolicLink()) {
        recordLink(abs, rel)
        continue
      }
      if (st.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (st.isFile()) {
        await recordFile(abs, rel, st)
        continue
      }
      // fifo/socket/device/other special file: recorded, never read.
      files.push({
        path: rel,
        type: 'unsupported',
        size: Number(st.size),
        protected: false,
        reasonUnprotected: 'unsupported-special-file',
      })
      countUnprotected(stats, 'unsupported-special-file')
    }
  }

  function recordLink(abs: string, rel: string): void {
    let target: string
    try {
      target = readlinkSync(abs)
    } catch {
      files.push({
        path: rel,
        type: 'symlink',
        size: 0,
        protected: false,
        reasonUnprotected: 'symlink-policy-rejected',
      })
      countUnprotected(stats, 'symlink-policy-rejected')
      return
    }
    // Recorded, never followed: restorable later by re-creating the link
    // (TRANSACTION_MODEL §2.1). Content behind the link is NOT snapshotted.
    files.push({
      path: rel,
      type: process.platform === 'win32' ? 'junction' : 'symlink',
      size: 0,
      protected: true,
      symlinkTarget: target,
    })
    stats.symlinks++
  }

  function posixModeOf(st: BigIntStats | undefined): number | undefined {
  // OQ-07 (approved): POSIX regular-file rwx bits only; Windows makes no ACL promise.
  return process.platform === 'win32' || st === undefined ? undefined : Number(st.mode & 0o777n)
}

async function recordFile(abs: string, rel: string, st: BigIntStats): Promise<void> {
    const sizeNumber = Number(st.size)
    if (sizeNumber > options.maxFileSizeBytes) {
      files.push({
        path: rel,
        type: 'file',
        size: sizeNumber,
        mtimeNs: st.mtimeNs.toString(),
        mode: posixModeOf(st),
        protected: false,
        reasonUnprotected: 'file-too-large',
      })
      countUnprotected(stats, 'file-too-large')
      return
    }

    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Each attempt observes a FRESH identity: a mutating writer converges
      // once writes stop; an active writer keeps failing until fail-closed.
      let identity: FileIdentity
      let mtimeNs: string
      let attemptMode: number | undefined
      try {
        const cur = attempt === 0 ? st : lstatSync(abs, { bigint: true })
        identity = { size: cur.size, mtimeNs: cur.mtimeNs, ino: cur.ino, dev: cur.dev }
        mtimeNs = cur.mtimeNs.toString()
        // R1: capture mode from THIS attempt's stat so a retry after a failed
        // stable read never carries the earlier attempt's (stale) mode.
        attemptMode = process.platform === 'win32' ? undefined : Number(cur.mode & 0o777n)
      } catch {
        files.push({
          path: rel,
          type: 'file',
          size: sizeNumber,
          protected: false,
          reasonUnprotected: 'inaccessible',
        })
        countUnprotected(stats, 'inaccessible')
        return
      }
      try {
        const hash = await options.cas.putFileStable(abs, identity)
        // R1: the accepted record's content and mode must come from the same
        // accepted read. chmod does not change size/mtime/ino/dev, so re-check
        // the mode right after the stable read and retry if it moved; a mode
        // that changed during the read belongs to a different state than the
        // bytes we accepted.
        if (process.platform !== 'win32') {
          let after: BigIntStats | undefined
          try { after = lstatSync(abs, { bigint: true }) } catch { after = undefined }
          if (after === undefined || Number(after.mode & 0o777n) !== (attemptMode ?? -1)) {
            lastError = new AgentCommitError(
              ErrorCodes.FileChangedDuringSnapshot,
              'File mode changed while being read for snapshot (R1); this read result is discarded and retried — no baseline is claimed for a mixed content/mode state.',
            )
            continue
          }
        }
        files.push({
          path: rel,
          type: 'file',
          hash,
          size: Number(identity.size),
          mtimeNs,
          mode: attemptMode,
          protected: true,
        })
        stats.protectedFiles++
        return
      } catch (error) {
        if (error instanceof AgentCommitError && error.code === ErrorCodes.BlobCorrupt) {
          throw error // Blocker 4: never scan successfully over a corrupt baseline
        }
        if (
          error instanceof AgentCommitError &&
          error.code === ErrorCodes.FileChangedDuringSnapshot
        ) {
          lastError = error
          continue // limited retry
        }
        // Permission denied, locked by another process, race, ... — recorded,
        // reported, never silently skipped (docs/STORAGE.md §5).
        files.push({
          path: rel,
          type: 'file',
          size: sizeNumber,
          mtimeNs,
          protected: false,
          reasonUnprotected: 'inaccessible',
        })
        countUnprotected(stats, 'inaccessible')
        return
      }
    }
    // Still unstable after retries: FAIL CLOSED — this scan produces no
    // successful manifest baseline (see stable-read limitations, P1 report).
    throw lastError
  }
}

export { ALL_UNPROTECTED_REASONS }
