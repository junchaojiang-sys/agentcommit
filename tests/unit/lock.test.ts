import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AgentCommitError,
  ErrorCodes,
  acquireLock,
  lockPath,
  readLock,
  releaseLock,
} from '@agentcommit/core'
import { makeTempDir } from '../helpers.js'

function seedLock(stateRoot: string, workspaceId: string, content: unknown): void {
  const p = lockPath(stateRoot, workspaceId)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content))
}

describe('workspace lock (frozen: fail closed, deterministic stale, no guessing)', () => {
  it('acquires when no lock exists and writes holder metadata', () => {
    const stateRoot = makeTempDir()
    const lock = acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 's1' })
    expect(lock.sessionId).toBe('s1')
    expect(lock.pid).toBe(process.pid)
    expect(existsSync(lockPath(stateRoot, 'ws1'))).toBe(true)
    const raw = JSON.parse(readFileSync(lockPath(stateRoot, 'ws1'), 'utf8'))
    expect(raw.hostname).toBe(os.hostname())
  })

  it('a valid lock fails closed with WORKSPACE_LOCKED', () => {
    const stateRoot = makeTempDir()
    acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 's1' })
    try {
      acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 's2' })
      expect.unreachable('acquire should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceLocked)
    }
  })

  it('is re-entrant for the same process + session', () => {
    const stateRoot = makeTempDir()
    acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 's1' })
    const again = acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 's1' })
    expect(again.sessionId).toBe('s1')
  })

  it('a proven-stale lock (holder process gone, same host) is detected deterministically', () => {
    const stateRoot = makeTempDir()
    // A real exited process: its pid is provably dead on this host.
    const dead = spawnSync(process.execPath, ['-e', ''])
    const deadPid = dead.pid ?? -1

    seedLock(stateRoot, 'ws1', {
      workspaceId: 'ws1',
      sessionId: 'ghost-session',
      pid: deadPid,
      hostname: os.hostname(),
      processStartedAt: 0,
      createdAt: new Date(0).toISOString(),
    })

    const lock = acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 's-live' })
    expect(lock.sessionId).toBe('s-live') // stale lock was deterministically replaced
  })

  it('a lock whose pid is alive is VALID — refused, never guessed (pid reuse safety)', () => {
    const stateRoot = makeTempDir()
    seedLock(stateRoot, 'ws1', {
      workspaceId: 'ws1',
      sessionId: 'other',
      pid: process.pid, // alive
      hostname: os.hostname(),
      processStartedAt: 0,
      createdAt: new Date().toISOString(),
    })
    try {
      acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 'mine' })
      expect.unreachable('acquire should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceLocked)
    }
  })

  it('a foreign-host lock cannot be proven stale — fail closed', () => {
    const stateRoot = makeTempDir()
    seedLock(stateRoot, 'ws1', {
      workspaceId: 'ws1',
      sessionId: 'remote',
      pid: 1,
      hostname: 'some-other-machine',
      processStartedAt: 0,
      createdAt: new Date(0).toISOString(),
    })
    try {
      acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 'mine' })
      expect.unreachable('acquire should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceLocked)
    }
  })

  it('an unreadable lock is treated as valid — fail closed, never auto-deleted', () => {
    const stateRoot = makeTempDir()
    seedLock(stateRoot, 'ws1', '{ this is not json {{{')
    try {
      acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 'mine' })
      expect.unreachable('acquire should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceLocked)
    }
    // the unknown lock was NOT deleted
    expect(existsSync(lockPath(stateRoot, 'ws1'))).toBe(true)
  })

  it('release removes only the owning session lock', () => {
    const stateRoot = makeTempDir()
    acquireLock(stateRoot, { workspaceId: 'ws1', sessionId: 's1' })

    expect(releaseLock(stateRoot, 'ws1', 'wrong-session')).toBe(false)
    expect(existsSync(lockPath(stateRoot, 'ws1'))).toBe(true)

    expect(releaseLock(stateRoot, 'ws1', 's1')).toBe(true)
    expect(existsSync(lockPath(stateRoot, 'ws1'))).toBe(false)

    expect(releaseLock(stateRoot, 'ws1', 's1')).toBe(false) // already gone
  })

  it('readLock reports absent / readable / unreadable states', () => {
    const stateRoot = makeTempDir()
    expect(readLock(stateRoot, 'nope').state).toBe('absent')
    acquireLock(stateRoot, { workspaceId: 'ws9', sessionId: 'sx' })
    const readable = readLock(stateRoot, 'ws9')
    expect(readable.state).toBe('readable')
    seedLock(stateRoot, 'broken', 'garbage{{')
    expect(readLock(stateRoot, 'broken').state).toBe('unreadable')
  })
})
