import { existsSync, openSync, closeSync, writeSync, readFileSync, rmSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { ensureDir } from './atomic.js'
import { locksDir, lockPath } from './paths.js'

/**
 * Workspace lock content (docs/TRANSACTION_MODEL §3). `processStartedAt` is
 * recorded for diagnostics and future refinement; current staleness rules use
 * hostname + pid liveness only, which is fully deterministic without native
 * dependencies.
 */
export interface LockContent {
  workspaceId: string
  sessionId: string
  pid: number
  hostname: string
  /** Approximate holder process start (ms epoch). */
  processStartedAt: number
  /** ISO-8601 UTC. */
  createdAt: string
  agentCommand?: string
}

export type LockReadState =
  | { state: 'absent' }
  | { state: 'readable'; content: LockContent }
  | { state: 'unreadable' }

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we may not signal it → alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readLock(stateRoot: string, workspaceId: string): LockReadState {
  const p = lockPath(stateRoot, workspaceId)
  if (!existsSync(p)) {
    return { state: 'absent' }
  }
  try {
    const content = JSON.parse(readFileSync(p, 'utf8')) as LockContent
    if (
      typeof content !== 'object' ||
      content === null ||
      typeof content['sessionId'] !== 'string' ||
      typeof content['pid'] !== 'number' ||
      typeof content['hostname'] !== 'string'
    ) {
      return { state: 'unreadable' }
    }
    return { state: 'readable', content }
  } catch {
    return { state: 'unreadable' }
  }
}

function lockedError(detail: string): AgentCommitError {
  return new AgentCommitError(
    ErrorCodes.WorkspaceLocked,
    `Another AgentCommit session holds this workspace (${detail}). Wait for it to finish, or — only if you have proven it is dead — run "agentcommit unlock --session <id>".`,
  )
}

/**
 * Acquire the workspace lock for a resolved workspace identity. Exclusive
 * create (fail closed), deterministic stale detection, re-entrant for the
 * same process + session. Never guesses: an unreadable lock, a foreign-host
 * lock, or a lock whose pid is alive is treated as VALID and refuses.
 */
export function acquireLock(
  stateRoot: string,
  wish: { workspaceId: string; sessionId: string; agentCommand?: string },
): LockContent {
  const dir = locksDir(stateRoot)
  ensureDir(dir)
  const p = lockPath(stateRoot, wish.workspaceId)
  const content: LockContent = {
    workspaceId: wish.workspaceId,
    sessionId: wish.sessionId,
    pid: process.pid,
    hostname: os.hostname(),
    processStartedAt: Math.round(performance.timeOrigin),
    createdAt: new Date().toISOString(),
    ...(wish.agentCommand !== undefined ? { agentCommand: wish.agentCommand } : {}),
  }

  let fd: number
  try {
    fd = openSync(p, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    const existing = readLock(stateRoot, wish.workspaceId)
    if (existing.state !== 'readable') {
      throw lockedError('lock file exists but is unreadable; it cannot be proven stale')
    }
    const held = existing.content
    if (held.pid === process.pid && held.hostname === content.hostname && held.sessionId === wish.sessionId) {
      return held // re-entrant: same process, same session
    }
    if (held.hostname !== content.hostname) {
      throw lockedError(`held on another host "${held.hostname}", session ${held.sessionId}, created ${held.createdAt}`)
    }
    if (isProcessAlive(held.pid)) {
      // Possibly a reused pid — cannot prove staleness → valid, refuse.
      throw lockedError(`pid ${held.pid} is alive, session ${held.sessionId}, created ${held.createdAt}`)
    }
    // Deterministic stale: same host, holder process provably gone.
    rmSync(p, { force: true })
    return acquireLock(stateRoot, wish)
  }

  try {
    writeSync(fd, JSON.stringify(content, null, 2))
  } finally {
    closeSync(fd)
  }
  return content
}

/**
 * Release the lock only if it belongs to the given session. Never removes a
 * foreign or unreadable lock (returns false instead).
 */
export function releaseLock(
  stateRoot: string,
  workspaceId: string,
  sessionId: string,
): boolean {
  const p = lockPath(stateRoot, workspaceId)
  if (!existsSync(p)) {
    return false
  }
  const existing = readLock(stateRoot, workspaceId)
  if (existing.state !== 'readable' || existing.content.sessionId !== sessionId) {
    return false
  }
  rmSync(p, { force: true })
  return true
}

/** Absolute lock file path (exposed for tests and diagnostics). */
export function lockFilePath(stateRoot: string, workspaceId: string): string {
  return path.join(locksDir(stateRoot), `${workspaceId}.lock`)
}
