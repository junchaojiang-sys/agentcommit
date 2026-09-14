import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionStatus, sessionAdmission, sessionsDir } from '@agentcommit/core'
import { makeStateRoot, makeTempDir } from '../helpers.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

const workspaceId = 'workspace-under-test'

function writeSession(stateRoot: string, id: string, body: unknown): string {
  const dir = sessionsDir(stateRoot, workspaceId)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.json`)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}

describe('sessionAdmission', () => {
  it('allows a workspace with no sessions directory', () => {
    const stateRoot = makeStateRoot(makeTempDir())

    expect(sessionAdmission(stateRoot, workspaceId)).toEqual({
      eligible: true,
      blockers: [],
    })
  })

  it.each([
    SessionStatus.Committed,
    SessionStatus.RolledBack,
    SessionStatus.Failed,
  ])('allows the known terminal status %s and preserves its file', (status) => {
    const stateRoot = makeStateRoot(makeTempDir())
    const file = writeSession(stateRoot, 'terminal', { status })

    expect(sessionAdmission(stateRoot, workspaceId)).toEqual({
      eligible: true,
      blockers: [],
    })
    expect(readdirSync(path.dirname(file))).toContain(path.basename(file))
  })

  it.each([
    SessionStatus.Ready,
    SessionStatus.Snapshot,
    SessionStatus.Running,
    SessionStatus.Review,
    SessionStatus.RollbackFailed,
  ])('rejects the blocking status %s', (status) => {
    const stateRoot = makeStateRoot(makeTempDir())
    writeSession(stateRoot, 'blocked', { status })

    const result = sessionAdmission(stateRoot, workspaceId)

    expect(result.eligible).toBe(false)
    expect(result.blockers).toEqual([`blocked (status: ${status})`])
  })

  it.each([
    ['corrupt JSON', '{'],
    ['null', null],
    ['an array', []],
    ['an empty object', {}],
    ['missing status', { id: 'missing-status' }],
    ['an unknown status', { status: 'mystery' }],
  ])('rejects %s session data', (_label, body) => {
    const stateRoot = makeStateRoot(makeTempDir())
    writeSession(stateRoot, 'invalid', body)

    expect(sessionAdmission(stateRoot, workspaceId).eligible).toBe(false)
  })

  it('rejects when the sessions path is not a directory', () => {
    const stateRoot = makeStateRoot(makeTempDir())
    const dir = sessionsDir(stateRoot, workspaceId)
    mkdirSync(path.dirname(dir), { recursive: true })
    writeFileSync(dir, 'not a directory')

    expect(sessionAdmission(stateRoot, workspaceId).eligible).toBe(false)
  })

  it('rejects a permissions error while listing sessions', () => {
    vi.mocked(readdirSync).mockImplementationOnce(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    })

    const result = sessionAdmission(makeStateRoot(makeTempDir()), workspaceId)

    expect(result.eligible).toBe(false)
    expect(result.blockers[0]).toContain('sessions dir unreadable')
  })
})
