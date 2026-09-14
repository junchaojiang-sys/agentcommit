import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { observationPathProblem } from './path-safety.js'

export interface CurrentObservation {
  path: string
  exists: boolean
  type?: 'file' | 'symlink' | 'directory' | 'other'
  /** SHA-256 of content for regular files within the size bound. */
  hash?: string
  /** POSIX rwx bits of a regular file observation (Windows: undefined). */
  mode?: number
  symlinkTarget?: string
  size?: number
  /** Why the observation is unreliable, if it is. */
  error?: 'inaccessible' | 'oversized' | 'special-file'
}

/**
 * Fresh observation of Current for the given paths (P2-A). Current is NEVER
 * taken from a cached manifest — it is re-stat'ed/hashed now so a plan reflects
 * the workspace at planning time. Links are recorded, never followed.
 */
export function observeCurrent(
  root: string,
  paths: readonly string[],
  options: { maxHashSizeBytes?: number } = {},
): Map<string, CurrentObservation> {
  const max = options.maxHashSizeBytes ?? 100 * 1024 * 1024
  const result = new Map<string, CurrentObservation>()
  // Validate the complete request before touching any target. The planner also
  // checks first so rejected paths can be reported as blocked plan entries.
  for (const rel of paths) {
    const problem = observationPathProblem(root, rel)
    if (problem) throw new AgentCommitError(ErrorCodes.StateCorrupt, `Unsafe observation path: ${problem}`)
  }
  for (const rel of paths) {
    const abs = path.join(root, rel)
    let st
    try {
      st = lstatSync(abs, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Clean, reliable absence — the path is provably not there.
        result.set(rel, { path: rel, exists: false })
      } else {
        // lstat itself failed (permissions/race): an UNRELIABLE observation —
        // not evidence of absence. Callers must treat this as Unknown.
        result.set(rel, { path: rel, exists: false, error: 'inaccessible' })
      }
      continue
    }
    if (st.isSymbolicLink()) {
      let target: string | undefined
      try {
        target = readlinkSync(abs)
      } catch {
        target = undefined
      }
      result.set(rel, { path: rel, exists: true, type: 'symlink', symlinkTarget: target })
      continue
    }
    if (st.isDirectory()) {
      result.set(rel, { path: rel, exists: true, type: 'directory', size: Number(st.size) })
      continue
    }
    if (st.isFile()) {
      const size = Number(st.size)
      if (size > max) {
        result.set(rel, { path: rel, exists: true, type: 'file', size, error: 'oversized' })
        continue
      }
      try {
        const data = readFileSync(abs)
        result.set(rel, {
          path: rel,
          exists: true,
          type: 'file',
          size,
          hash: createHash('sha256').update(data).digest('hex'),
          ...(process.platform === 'win32' ? {} : { mode: Number(st.mode & 0o777n) }),
        })
      } catch {
        result.set(rel, { path: rel, exists: true, type: 'file', size, error: 'inaccessible' })
      }
      continue
    }
    result.set(rel, {
      path: rel,
      exists: true,
      type: 'other',
      size: Number(st.size),
      error: 'special-file',
    })
  }
  return result
}
