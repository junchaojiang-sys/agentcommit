import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptSession,
  createPreSnapshot,
  executeRestore,
  initializeWorkspace,
  inspectSession,
  listWorkspaceSessions,
  loadRestoreJournal,
  loadSession,
  prepareRestore,
  persistRestoreJournal,
  readLock,
  runSession,
  sessionAdmission,
  SessionStatus,
  unlockWorkspace,
  updateAgentRegistration,
  AgentCommitError,
  ErrorCodes,
} from '@agentcommit/core'
import { lockPath, manifestPath, sessionPath } from '../../packages/core/src/storage/paths.js'
import { restoreFixture } from '../p2b-helpers.js'
import { makeStateRoot, makeTempDir, writeTree } from '../helpers.js'

const childScript = fileURLToPath(new URL('../fixtures/p3-child.mjs', import.meta.url))
const temporaryRoots: string[] = []

function workspaceFixture() {
  const temporaryRoot = makeTempDir('agentcommit-p3-lifecycle-')
  temporaryRoots.push(temporaryRoot)
  const workspaceRoot = path.join(temporaryRoot, 'workspace')
  mkdirSync(workspaceRoot)
  initializeWorkspace(workspaceRoot)
  const stateRoot = makeStateRoot(temporaryRoot)
  writeTree(workspaceRoot, { 'original.txt': 'before' })
  return { temporaryRoot, workspaceRoot, stateRoot }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  temporaryRoots.length = 0
})

describe('P3 Generic Wrapper and Session lifecycle', () => {
  it('lists strictly validated sessions newest first with a deterministic tie order', async () => {
    const fixture = workspaceFixture()
    const first = await createPreSnapshot({ ...fixture, sessionId: 'session-a' })
    const second = await createPreSnapshot({ ...fixture, sessionId: 'session-b' })
    const firstFile = sessionPath(fixture.stateRoot, first.session.workspaceId, first.session.id)
    const secondFile = sessionPath(fixture.stateRoot, second.session.workspaceId, second.session.id)
    const a = JSON.parse(readFileSync(firstFile, 'utf8'))
    const b = JSON.parse(readFileSync(secondFile, 'utf8'))
    a.startedAt = '2026-09-08T00:00:00.000Z'
    b.startedAt = '2026-09-08T00:00:01.000Z'
    writeFileSync(firstFile, JSON.stringify(a))
    writeFileSync(secondFile, JSON.stringify(b))

    const sessions = listWorkspaceSessions(fixture)
    expect(sessions.map((session) => session.id)).toEqual(['session-b', 'session-a'])

    writeFileSync(path.join(path.dirname(firstFile), 'bad..json'), JSON.stringify({ ...a, id: 'bad.' }))
    expect(() => listWorkspaceSessions(fixture)).toThrow(/safe|invalid|corrupt/i)
  })

  it('unlocks only the named current-workspace session held by a dead pid on this host', async () => {
    const fixture = workspaceFixture()
    const pre = await createPreSnapshot({ ...fixture, sessionId: 'dead-session' })
    const file = lockPath(fixture.stateRoot, pre.session.workspaceId)
    writeFileSync(file, JSON.stringify({
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pid: 2_147_483_647,
      hostname: os.hostname(),
      processStartedAt: 0,
      createdAt: '2026-09-08T00:00:00.000Z',
    }))

    unlockWorkspace({ ...fixture, sessionId: pre.session.id })
    expect(readLock(fixture.stateRoot, pre.session.workspaceId)).toEqual({ state: 'absent' })
  })

  it('refuses to unlock a live, foreign-host, wrong-session, or unreadable lock', async () => {
    const fixture = workspaceFixture()
    const pre = await createPreSnapshot({ ...fixture, sessionId: 'owned-session' })
    const file = lockPath(fixture.stateRoot, pre.session.workspaceId)
    const base = {
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pid: process.pid,
      hostname: os.hostname(),
      processStartedAt: 0,
      createdAt: '2026-09-08T00:00:00.000Z',
    }
    for (const [name, value, sessionId] of [
      ['live', base, pre.session.id],
      ['foreign', { ...base, pid: 2_147_483_647, hostname: 'different-host' }, pre.session.id],
      ['wrong-session', { ...base, pid: 2_147_483_647 }, 'other-session'],
      ['unreadable', '{', pre.session.id],
    ] as const) {
      writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
      expect(() => unlockWorkspace({ ...fixture, sessionId }), name).toThrow()
      expect(existsSync(file), name).toBe(true)
    }
  })

  it('accepts a review Session and permits a new Session', async () => {
    const fixture = workspaceFixture()
    const result = await runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'accepted.txt', '0', 'ok'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })

    const accepted = acceptSession({ ...fixture, sessionId: result.session.id })
    expect(accepted.status).toBe(SessionStatus.Committed)
    expect(sessionAdmission(fixture.stateRoot, accepted.workspaceId).eligible).toBe(true)
    await expect(createPreSnapshot(fixture)).resolves.toBeDefined()
  })

  it('refuses to accept when the two latest Sessions have tied timestamps', async () => {
    const fixture = workspaceFixture()
    const first = await createPreSnapshot({ ...fixture, sessionId: 'tie-a' })
    const second = await createPreSnapshot({ ...fixture, sessionId: 'tie-b' })
    const tiedAt = '2026-09-08T00:00:00.000Z'
    for (const session of [first.session, second.session]) {
      writeFileSync(sessionPath(fixture.stateRoot, session.workspaceId, session.id), JSON.stringify({
        ...session,
        status: SessionStatus.Review,
        startedAt: tiedAt,
      }))
    }

    let error: unknown
    try {
      acceptSession({ ...fixture, sessionId: first.session.id })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AgentCommitError)
    expect((error as AgentCommitError).code).toBe(ErrorCodes.StateCorrupt)
    expect(loadSession(fixture.stateRoot, first.session.workspaceId, first.session.id).status).toBe(SessionStatus.Review)
    expect(loadSession(fixture.stateRoot, second.session.workspaceId, second.session.id).status).toBe(SessionStatus.Review)
  })

  it('archives a completed scoped Journal before accepting, then permits a new Session', async () => {
    const fixture = await restoreFixture()
    temporaryRoots.push(fixture.temporaryRoot)
    const plan = await prepareRestore({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, scope: 'a-modified.txt' })
    const restored = await executeRestore({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, plan })
    expect(restored.status).toBe('succeeded')
    expect(loadRestoreJournal(fixture.stateRoot, plan.workspaceId, plan.sessionId)?.status).toBe('completed')

    const accepted = acceptSession({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, sessionId: plan.sessionId })
    expect(accepted.status).toBe(SessionStatus.Committed)
    expect(loadRestoreJournal(fixture.stateRoot, plan.workspaceId, plan.sessionId)).toBeUndefined()
    expect(sessionAdmission(fixture.stateRoot, plan.workspaceId).eligible).toBe(true)
    await expect(createPreSnapshot({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot })).resolves.toBeDefined()
  })

  it('finishes an interrupted scoped acceptance from committed plus the same completed Journal', async () => {
    const fixture = await restoreFixture()
    temporaryRoots.push(fixture.temporaryRoot)
    const plan = await prepareRestore({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, scope: 'a-modified.txt' })
    expect((await executeRestore({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, plan })).status).toBe('succeeded')
    const review = loadSession(fixture.stateRoot, plan.workspaceId, plan.sessionId)
    const committed = { ...review, status: SessionStatus.Committed, endedAt: new Date().toISOString() }
    writeFileSync(sessionPath(fixture.stateRoot, plan.workspaceId, plan.sessionId), JSON.stringify(committed))

    expect(acceptSession({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, sessionId: plan.sessionId }).status).toBe(SessionStatus.Committed)
    expect(loadRestoreJournal(fixture.stateRoot, plan.workspaceId, plan.sessionId)).toBeUndefined()
    expect(sessionAdmission(fixture.stateRoot, plan.workspaceId).eligible).toBe(true)
  })

  it.each([undefined, 'a-modified.txt'])('accepts a prepared %s plan only when no restore attempt or receipt exists', async (scope) => {
    const fixture = await restoreFixture()
    temporaryRoots.push(fixture.temporaryRoot)
    const plan = await prepareRestore({
      workspaceRoot: fixture.workspaceRoot,
      stateRoot: fixture.stateRoot,
      ...(scope ? { scope } : {}),
    })
    const journal = loadRestoreJournal(fixture.stateRoot, plan.workspaceId, plan.sessionId)
    expect(journal).toMatchObject({ status: 'prepared', attempts: [] })

    const accepted = acceptSession({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, sessionId: plan.sessionId })
    expect(accepted.status).toBe(SessionStatus.Committed)
    expect(loadRestoreJournal(fixture.stateRoot, plan.workspaceId, plan.sessionId)).toBeUndefined()
    expect(sessionAdmission(fixture.stateRoot, plan.workspaceId).eligible).toBe(true)
  })

  it('finishes an interrupted acceptance from committed plus the same zero-effect prepared Journal', async () => {
    const fixture = await restoreFixture()
    temporaryRoots.push(fixture.temporaryRoot)
    const plan = await prepareRestore({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot })
    const review = loadSession(fixture.stateRoot, plan.workspaceId, plan.sessionId)
    writeFileSync(sessionPath(fixture.stateRoot, plan.workspaceId, plan.sessionId), JSON.stringify({
      ...review,
      status: SessionStatus.Committed,
      endedAt: new Date().toISOString(),
    }))

    expect(acceptSession({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, sessionId: plan.sessionId }).status).toBe(SessionStatus.Committed)
    expect(loadRestoreJournal(fixture.stateRoot, plan.workspaceId, plan.sessionId)).toBeUndefined()
  })

  it.each(['intent', 'verified', 'receipt'])('refuses a prepared Journal carrying a restore %s', async (kind) => {
    const fixture = await restoreFixture()
    temporaryRoots.push(fixture.temporaryRoot)
    const plan = await prepareRestore({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot })
    const journal = loadRestoreJournal(fixture.stateRoot, plan.workspaceId, plan.sessionId)!
    const action = plan.actions[0]!
    if (kind === 'receipt') {
      persistRestoreJournal(fixture.stateRoot, {
        ...journal,
        completedReceipts: [{
          path: action.path,
          expectedFingerprint: 'file:tampered:-',
          planId: plan.planId,
          planDigest: plan.planDigest,
          attemptId: 'missing-attempt',
        }],
      })
    } else {
      persistRestoreJournal(fixture.stateRoot, {
        ...journal,
        attempts: [{
          id: 'attempt-evidence',
          startedAt: '2026-09-08T00:00:00.000Z',
          status: kind === 'verified' ? 'completed' : 'failed',
          actions: [{
            actionId: action.id,
            path: action.path,
            beforeFingerprint: 'before-evidence',
            expectedFingerprint: 'expected-evidence',
            status: kind,
            ...(kind === 'verified' ? { verifiedAt: '2026-09-08T00:00:01.000Z' } : {}),
          }],
        }],
      })
    }

    expect(() => acceptSession({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, sessionId: plan.sessionId })).toThrow()
    expect(loadSession(fixture.stateRoot, plan.workspaceId, plan.sessionId).status).toBe(SessionStatus.Review)
    expect(existsSync(path.join(fixture.stateRoot, 'workspaces', plan.workspaceId, 'sessions', `${plan.sessionId}.journal.json`))).toBe(true)
  })

  it('refuses zero-effect prepared acceptance when the Session Manifest references no longer match the Journal plan', async () => {
    const fixture = await restoreFixture()
    temporaryRoots.push(fixture.temporaryRoot)
    const plan = await prepareRestore({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot })
    const session = loadSession(fixture.stateRoot, plan.workspaceId, plan.sessionId)
    writeFileSync(sessionPath(fixture.stateRoot, plan.workspaceId, plan.sessionId), JSON.stringify({
      ...session,
      postManifestRef: session.preManifestRef,
    }))

    expect(() => acceptSession({ workspaceRoot: fixture.workspaceRoot, stateRoot: fixture.stateRoot, sessionId: plan.sessionId })).toThrow(/Manifest|bound|reference|input/i)
    expect(loadRestoreJournal(fixture.stateRoot, plan.workspaceId, plan.sessionId)).toBeDefined()
    expect(loadSession(fixture.stateRoot, plan.workspaceId, plan.sessionId).status).toBe(SessionStatus.Review)
  })

  it('fails closed when accepting a Journal with action intent or corrupt data', async () => {
    const unfinished = await restoreFixture()
    temporaryRoots.push(unfinished.temporaryRoot)
    const plan = await prepareRestore({ workspaceRoot: unfinished.workspaceRoot, stateRoot: unfinished.stateRoot, scope: 'a-modified.txt' })
    const prepared = loadRestoreJournal(unfinished.stateRoot, plan.workspaceId, plan.sessionId)!
    const action = plan.actions[0]!
    persistRestoreJournal(unfinished.stateRoot, {
      ...prepared,
      status: 'executing',
      attempts: [{
        id: 'attempt-with-intent',
        startedAt: '2026-09-08T00:00:00.000Z',
        status: 'running',
        actions: [{
          actionId: action.id,
          path: action.path,
          beforeFingerprint: 'before',
          expectedFingerprint: 'expected',
          status: 'intent',
        }],
      }],
    })
    expect(() => acceptSession({ workspaceRoot: unfinished.workspaceRoot, stateRoot: unfinished.stateRoot, sessionId: plan.sessionId })).toThrow()
    expect(loadSession(unfinished.stateRoot, plan.workspaceId, plan.sessionId).status).toBe(SessionStatus.Review)

    const file = path.join(unfinished.stateRoot, 'workspaces', plan.workspaceId, 'sessions', `${plan.sessionId}.journal.json`)
    writeFileSync(file, '{')
    let corruptError: unknown
    try {
      acceptSession({ workspaceRoot: unfinished.workspaceRoot, stateRoot: unfinished.stateRoot, sessionId: plan.sessionId })
    } catch (error) {
      corruptError = error
    }
    expect(corruptError).toBeInstanceOf(AgentCommitError)
    expect((corruptError as AgentCommitError).code).toBe(ErrorCodes.StateCorrupt)
    expect(loadSession(unfinished.stateRoot, plan.workspaceId, plan.sessionId).status).toBe(SessionStatus.Review)
  })

  it('inspects a review Session only after validating its Manifest and frozen policy bindings', async () => {
    const fixture = workspaceFixture()
    const result = await runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'inspect.txt', '0'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })
    const inspected = inspectSession({ ...fixture, sessionId: result.session.id })
    expect(inspected.session.status).toBe(SessionStatus.Review)
    expect(inspected.pre?.id).toBe(result.session.preManifestRef)
    expect(inspected.post?.id).toBe(result.session.postManifestRef)

    const postFile = manifestPath(fixture.stateRoot, result.session.workspaceId, result.session.postManifestRef!)
    const post = JSON.parse(readFileSync(postFile, 'utf8'))
    post.protectionPolicy.ignoreRules = ['changed-after-run']
    writeFileSync(postFile, JSON.stringify(post))
    expect(() => inspectSession({ ...fixture, sessionId: result.session.id })).toThrow(/policy|Manifest|input/i)
  })

  it('runs executable plus literal argv without shell evaluation and persists review for exit zero', async () => {
    const fixture = workspaceFixture()
    const shellText = 'literal && echo never-evaluated'
    const result = await runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'argv.json', '0', shellText, '中文 参数'] },
      agent: { kind: 'generic', command: process.execPath, version: process.version },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })

    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.session.status).toBe(SessionStatus.Review)
    expect(result.session.changes.map((change) => change.path)).toContain('argv.json')
    expect(JSON.parse(readFileSync(path.join(fixture.workspaceRoot, 'argv.json'), 'utf8'))).toEqual([shellText, '中文 参数'])
    expect(readLock(fixture.stateRoot, result.session.workspaceId)).toEqual({ state: 'absent' })
    expect(loadSession(fixture.stateRoot, result.session.workspaceId, result.session.id).verification).toEqual({
      exitCode: 0,
      checks: ['post-scan', 'change-set'],
    })
  })

  it('captures Post and enters review when the child exits nonzero', async () => {
    const fixture = workspaceFixture()
    const result = await runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'nonzero.txt', '23', 'written'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })

    expect(result.exitCode).toBe(23)
    expect(result.session.status).toBe(SessionStatus.Review)
    expect(result.session.changes.map((change) => change.path)).toContain('nonzero.txt')
  })

  it('forwards an abort signal, then captures the child final state in review', async () => {
    const fixture = workspaceFixture()
    const controller = new AbortController()
    const running = runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'signal', fixture.workspaceRoot, 'ready.txt', 'signal.txt'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
      signalSource: controller.signal,
    })
    await waitForFile(path.join(fixture.workspaceRoot, 'ready.txt'))
    const active = listWorkspaceSessions(fixture)
    expect(active).toHaveLength(1)
    expect(active[0]?.status).toBe(SessionStatus.Running)
    await expect(runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'second.txt', '0'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })).rejects.toThrow(/lock|unfinished Session/i)
    expect(existsSync(path.join(fixture.workspaceRoot, 'second.txt'))).toBe(false)
    controller.abort('SIGTERM')
    const result = await running

    expect(result.signal).toBe('SIGTERM')
    expect(result.exitCode).toBeNull()
    expect(result.session.status).toBe(SessionStatus.Review)
    expect(result.session.postManifestRef).toBeDefined()
    expect(result.session.changes.map((change) => change.path)).toContain('ready.txt')
  })

  it('records a spawn failure as failed and releases the retained lock', async () => {
    const fixture = workspaceFixture()
    await expect(runSession({
      ...fixture,
      command: { command: path.join(fixture.temporaryRoot, 'missing-executable'), args: [] },
      agent: { kind: 'generic', command: path.join(fixture.temporaryRoot, 'missing-executable') },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })).rejects.toThrow()

    const sessions = listWorkspaceSessions(fixture)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.status).toBe(SessionStatus.Failed)
    expect(readLock(fixture.stateRoot, sessions[0]!.workspaceId)).toEqual({ state: 'absent' })
  })

  it('fails closed and preserves a child-replaced lock instead of releasing by Session id alone', async () => {
    const fixture = workspaceFixture()
    const config = JSON.parse(readFileSync(path.join(fixture.workspaceRoot, '.agentcommit.json'), 'utf8'))
    const file = lockPath(fixture.stateRoot, config.workspaceId)
    await expect(runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'replace-lock', fixture.workspaceRoot, file, 'changed-lock.txt'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })).rejects.toThrow(/lock ownership/i)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(2_147_483_647)
    expect(listWorkspaceSessions(fixture)[0]?.status).toBe(SessionStatus.Running)
  })

  it('fails closed and retains its lock when the workspace identity changes before Post', async () => {
    const fixture = workspaceFixture()
    const configFile = path.join(fixture.workspaceRoot, '.agentcommit.json')
    const workspaceId = JSON.parse(readFileSync(configFile, 'utf8')).workspaceId as string
    const file = lockPath(fixture.stateRoot, workspaceId)
    await expect(runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'replace-workspace-id', fixture.workspaceRoot, configFile, 'changed-identity.txt'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })).rejects.toThrow(/identity|workspaceId/i)
    expect(existsSync(file)).toBe(true)
    const held = readLock(fixture.stateRoot, workspaceId)
    expect(held.state).toBe('readable')
    if (held.state === 'readable') {
      expect(loadSession(fixture.stateRoot, workspaceId, held.content.sessionId).status).toBe(SessionStatus.Running)
    }
  })

  it('rejects an agent identity that does not match the executable before creating a Session', async () => {
    const fixture = workspaceFixture()
    await expect(runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'bad.txt', '0'] },
      agent: { kind: 'generic', command: 'different-command' },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })).rejects.toThrow(/identity|command/i)
    expect(listWorkspaceSessions(fixture)).toEqual([])
    expect(existsSync(path.join(fixture.workspaceRoot, 'bad.txt'))).toBe(false)
  })

  it('rejects a state root inside the protected workspace before creating it or spawning', async () => {
    const fixture = workspaceFixture()
    const insideState = path.join(fixture.workspaceRoot, 'private-state')
    await expect(runSession({
      workspaceRoot: fixture.workspaceRoot,
      stateRoot: insideState,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'inside-state-run.txt', '0'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })).rejects.toThrow(/state root.*outside|inside the protected workspace/i)
    expect(existsSync(insideState)).toBe(false)
    expect(existsSync(path.join(fixture.workspaceRoot, 'inside-state-run.txt'))).toBe(false)
  })

  it('rejects an initial workspace root that is a directory link', async () => {
    const fixture = workspaceFixture()
    const alias = path.join(fixture.temporaryRoot, 'workspace-alias')
    symlinkSync(fixture.workspaceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(runSession({
      workspaceRoot: alias,
      stateRoot: fixture.stateRoot,
      command: { command: process.execPath, args: [childScript, 'argv', alias, 'linked-root-run.txt', '0'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })).rejects.toThrow(/real directory|link/i)
    expect(existsSync(path.join(fixture.workspaceRoot, 'linked-root-run.txt'))).toBe(false)
  })

  it.each([
    SessionStatus.Ready,
    SessionStatus.Snapshot,
    SessionStatus.Running,
    SessionStatus.Review,
  ])('refuses an existing %s Session before Pre or child spawn', async (status) => {
    const fixture = workspaceFixture()
    const existing = await createPreSnapshot({ ...fixture, sessionId: `existing-${status}` })
    writeFileSync(
      sessionPath(fixture.stateRoot, existing.session.workspaceId, existing.session.id),
      JSON.stringify({ ...existing.session, status }),
    )
    await expect(runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'unsafe-new-run.txt', '0'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => true,
      postExitGraceMs: 0,
    })).rejects.toThrow(/unfinished|admission|session/i)
    expect(existsSync(path.join(fixture.workspaceRoot, 'unsafe-new-run.txt'))).toBe(false)
    expect(listWorkspaceSessions(fixture).map((session) => session.id)).toEqual([existing.session.id])
  })

  it('a rejected protection gate never launches the child and leaves a terminal Session', async () => {
    const fixture = workspaceFixture()
    await expect(runSession({
      ...fixture,
      command: { command: process.execPath, args: [childScript, 'argv', fixture.workspaceRoot, 'denied.txt', '0'] },
      agent: { kind: 'generic', command: process.execPath },
      confirmProtection: async () => false,
      postExitGraceMs: 0,
    })).rejects.toThrow(/protection|confirm|declined/i)
    const sessions = listWorkspaceSessions(fixture)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.status).toBe(SessionStatus.Failed)
    expect(existsSync(path.join(fixture.workspaceRoot, 'denied.txt'))).toBe(false)
    expect(readLock(fixture.stateRoot, sessions[0]!.workspaceId)).toEqual({ state: 'absent' })
  })

  it('registers and removes a configurable agent command under the workspace lock', () => {
    const fixture = workspaceFixture()
    const registered = updateAgentRegistration({ ...fixture, name: 'zcode-local', command: 'zcode --profile safe' })
    expect(registered.agents['zcode-local']).toEqual({ command: 'zcode --profile safe' })
    expect(readLock(fixture.stateRoot, registered.workspaceId)).toEqual({ state: 'absent' })

    const removed = updateAgentRegistration({ ...fixture, name: 'zcode-local' })
    expect(removed.agents['zcode-local']).toBeUndefined()
    expect(readLock(fixture.stateRoot, removed.workspaceId)).toEqual({ state: 'absent' })
  })

  it.each(['__proto__', 'constructor', 'bad/name', ''])('rejects unsafe agent registration name %j without changing config', (name) => {
    const fixture = workspaceFixture()
    const before = readFileSync(path.join(fixture.workspaceRoot, '.agentcommit.json'))
    expect(() => updateAgentRegistration({ ...fixture, name, command: 'zcode' })).toThrow(/name|safe/i)
    expect(readFileSync(path.join(fixture.workspaceRoot, '.agentcommit.json'))).toEqual(before)
  })

  it('rejects a blank agent command and registration during an unfinished Session', async () => {
    const fixture = workspaceFixture()
    expect(() => updateAgentRegistration({ ...fixture, name: 'zcode', command: '   ' })).toThrow(/command/i)
    const pre = await createPreSnapshot({ ...fixture, sessionId: 'unfinished-registration' })
    expect(() => updateAgentRegistration({ ...fixture, name: 'zcode', command: 'zcode' })).toThrow(/unfinished|locked/i)
    expect(readLock(fixture.stateRoot, pre.session.workspaceId)).toEqual({ state: 'absent' })
  })

  it('fails closed without rewriting an existing malformed agent map', () => {
    const fixture = workspaceFixture()
    const configFile = path.join(fixture.workspaceRoot, '.agentcommit.json')
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    config.agents = { broken: { command: '' } }
    writeFileSync(configFile, JSON.stringify(config))
    const before = readFileSync(configFile)
    expect(() => updateAgentRegistration({ ...fixture, name: 'zcode', command: 'zcode' })).toThrow(/agent|command|config/i)
    expect(readFileSync(configFile)).toEqual(before)
  })
})
