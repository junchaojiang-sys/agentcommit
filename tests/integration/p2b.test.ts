import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as core from '@agentcommit/core'
import { captureTree, restoreFixture } from '../p2b-helpers.js'
import { makeTempDir, makeStateRoot, writeTree } from '../helpers.js'

describe('P2-B restore execution acceptance', () => {
  it('restores mixed text, binary, empty, Unicode paths and deleted/created files', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const result = await core.executeRestore({ ...f, plan })
    expect(result.status).toBe('succeeded')
    for (const [name, value] of Object.entries(f.original)) {
      expect(readFileSync(path.join(f.workspaceRoot, name))).toEqual(Buffer.from(value))
    }
    expect(existsSync(path.join(f.workspaceRoot, 'z-created.txt'))).toBe(false)
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).toBe('rolled_back')
    expect(captureTree(f.workspaceRoot).some((e) => e.path.includes('.tmp'))).toBe(false)
  })

  it('single path leaves other changes intact; later whole-session recovery rechecks receipts', async () => {
    const f = await restoreFixture()
    const single = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    const outsideBefore = readFileSync(path.join(f.workspaceRoot, 'outside-scope.txt'))
    expect((await core.executeRestore({ ...f, plan: single })).status).toBe('succeeded')
    expect(readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'utf8')).toBe(f.original['a-modified.txt'])
    expect(readFileSync(path.join(f.workspaceRoot, 'outside-scope.txt'))).toEqual(outsideBefore)
    expect(core.loadSession(f.stateRoot, single.workspaceId, single.sessionId).status).not.toBe('rolled_back')
    const singleJournal = core.loadRestoreJournal(f.stateRoot, single.workspaceId, single.sessionId)
    const whole = await core.prepareRestore(f)
    const archived = JSON.parse(readFileSync(core.archivedRestoreJournalPath(f.stateRoot, single.workspaceId, single.sessionId, single.planId), 'utf8'))
    expect(archived).toEqual(singleJournal)
    expect((await core.executeRestore({ ...f, plan: whole })).status).toBe('succeeded')
    expect(core.loadSession(f.stateRoot, whole.workspaceId, whole.sessionId).status).toBe('rolled_back')
  })

  it.each(['Post', 'a new user edit'])('whole-session recovery refuses a completed single path changed to %s, including Force', async (changedTo) => {
    const f = await restoreFixture()
    const postBytes = readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'))
    const single = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    expect((await core.executeRestore({ ...f, plan: single })).status).toBe('succeeded')
    writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), changedTo === 'Post' ? postBytes : 'new user text')
    const whole = await core.prepareRestore(f)
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan: whole })).status).toBe('rejected')
    const authorization = { schemaVersion: 1 as const, sessionId: whole.sessionId, planDigest: whole.planDigest, conflicts: whole.conflicts.map((c) => ({ path: c.path, currentFingerprint: c.currentFingerprint! })) }
    expect((await core.executeRestore({ ...f, plan: whole, forceAuthorization: authorization })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it.each(['user-edit', 'recreated', 'missing-blob', 'corrupt-blob', 'plan-binding', 'plan-actions', 'traversal'])('%s rejects before any target writes', async (scenario) => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    if (scenario === 'user-edit') writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'later user edit')
    if (scenario === 'recreated') writeFileSync(path.join(f.workspaceRoot, 'b-deleted.txt'), 'later recreation')
    if (scenario === 'plan-binding') plan.sessionId = 'wrong-session'
    if (scenario === 'plan-actions') {
      plan.actions.pop()
      const { planDigest: _digest, ...unsigned } = plan
      plan.planDigest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')
    }
    if (scenario === 'traversal') plan.actions[0]!.path = '../outside'
    if (scenario.includes('blob')) {
      const hash = f.pre.manifest.files.find((r) => r.path === 'a-modified.txt')!.hash!
      const blob = path.join(f.stateRoot, 'blobs', 'sha256', hash.slice(0, 2), hash.slice(2))
      if (scenario === 'missing-blob') unlinkSync(blob)
      else writeFileSync(blob, 'corrupt fixture blob')
    }
    const before = captureTree(f.workspaceRoot)
    const result = await core.executeRestore({ ...f, plan })
    expect(result.status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it.each(['after-intent', 'before-action', 'temp-write', 'after-replace', 'after-delete', 'after-verified'])('%s interruption can resume through the same executor', async (point) => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    let fired = false
    const hooks = { [point]: () => { if (!fired) { fired = true; throw new Error(`injected ${point}`) } } }
    const failed = await core.executeRestore({ ...f, plan, hooks })
    expect(fired).toBe(true)
    expect(['partial', 'retryable']).toContain(failed.status)
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).not.toBe('rolled_back')
    const resumed = await core.executeRestore({ ...f, plan })
    expect(resumed.status).toBe('succeeded')
    const completedJournal = core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)
    expect(completedJournal?.status).toBe('completed')
    if (point === 'after-replace') {
      const sourceAttempt = completedJournal!.attempts[0]!
      const recovered = completedJournal!.attempts.flatMap((a) => a.actions).find((a) => a.recoveredFromAttemptId)
      expect(sourceAttempt.actions[0]!.tempPath).toContain(sourceAttempt.id)
      expect(recovered?.recoveredFromAttemptId).toBe(sourceAttempt.id)
      expect(recovered?.tempPath).toBeUndefined()
    }
    expect(core.sessionAdmission(f.stateRoot, plan.workspaceId).eligible).toBe(true)
    expect(readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'utf8')).toBe(f.original['a-modified.txt'])
    expect(existsSync(path.join(f.workspaceRoot, 'z-created.txt'))).toBe(false)
  })

  it.each(['after-intent', 'after-verified', 'after-replace'])('single-path %s retry persists loadable state and permits the same Session whole restore', async (point) => {
    const f = await restoreFixture()
    const single = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    const failed = await core.executeRestore({ ...f, plan: single, hooks: { [point]: () => { throw new Error(`single-path ${point}`) } } })
    expect(['partial', 'retryable']).toContain(failed.status)
    expect(core.loadSession(f.stateRoot, single.workspaceId, single.sessionId).status).toBe('rollback_failed')
    expect((await core.executeRestore({ ...f, plan: single })).status).toBe('succeeded')
    expect(core.loadRestoreJournal(f.stateRoot, single.workspaceId, single.sessionId)?.status).toBe('completed')
    expect(core.loadSession(f.stateRoot, single.workspaceId, single.sessionId).status).toBe('review')
    expect(core.sessionAdmission(f.stateRoot, single.workspaceId).eligible).toBe(false)
    await expect(core.createPreSnapshot(f)).rejects.toThrow()
    const whole = await core.prepareRestore(f)
    expect(whole.sessionId).toBe(single.sessionId)
    expect((await core.executeRestore({ ...f, plan: whole })).status).toBe('succeeded')
    expect(core.loadRestoreJournal(f.stateRoot, whole.workspaceId, whole.sessionId)?.status).toBe('completed')
    expect(core.loadSession(f.stateRoot, whole.workspaceId, whole.sessionId).status).toBe('rolled_back')
    expect(core.sessionAdmission(f.stateRoot, whole.workspaceId).eligible).toBe(true)
  })

  it.each(['whole', 'single'])('completed %s Journal with an unfinalized Session can safely finish', async (scope) => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore({ ...f, ...(scope === 'single' ? { scope: 'a-modified.txt' } : {}) })
    await core.executeRestore({ ...f, plan, hooks: { 'after-intent': () => { throw new Error('failed attempt before completion') } } })
    const pendingSession = core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('succeeded')
    // Exact persisted-state fixture for termination after completed Journal but
    // before writing the Session update. The process test kills at this boundary.
    core.persistSession(f.stateRoot, plan.workspaceId, pendingSession)
    expect(core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)?.status).toBe('completed')
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('succeeded')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).toBe(scope === 'single' ? 'review' : 'rolled_back')
  })

  it('a completed label without verified action coverage cannot finalize a failed Session', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const journal = core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)!
    journal.status = 'completed'
    core.persistRestoreJournal(f.stateRoot, journal)
    const session = core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId)
    core.persistSession(f.stateRoot, plan.workspaceId, { ...session, status: core.SessionStatus.RollbackFailed })
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).toBe('rollback_failed')
  })

  it('a Session-finalization failure reports applied work and preserves the completed Journal for retry', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const failed = await core.executeRestore({ ...f, plan, hooks: { 'after-journal-completed': () => { throw new Error('injected Session finalization failure') } } })
    expect(failed.status).toBe('partial')
    expect(failed.error).toMatch(/finalization failure/)
    expect(core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)?.status).toBe('completed')
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).not.toBe('rolled_back')
    const before = captureTree(f.workspaceRoot)
    const failedAgain = await core.executeRestore({ ...f, plan, hooks: { 'after-journal-completed': () => { throw new Error('repeated finalization failure') } } })
    expect(failedAgain.status).toBe('partial')
    expect(core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)?.status).toBe('completed')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('succeeded')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).endedAt).toBeTruthy()
    expect(core.sessionAdmission(f.stateRoot, plan.workspaceId).eligible).toBe(true)
  })

  it('Current drift at the completion hook cannot be finalized as a successful Session', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const result = await core.executeRestore({ ...f, plan, hooks: { 'after-journal-completed': () => {
      writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user edit in finalization window')
    } } })
    expect(result.status).not.toBe('succeeded')
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).not.toBe('rolled_back')
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('CAS corruption in the finalization window cannot turn a failed Session into success', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const hash = plan.actions.find((action) => action.blobHash)!.blobHash!
    const result = await core.executeRestore({ ...f, plan, hooks: { 'after-journal-completed': () => {
      writeFileSync(path.join(f.stateRoot, 'blobs', 'sha256', hash.slice(0, 2), hash.slice(2)), 'corrupted before Session update')
    } } })
    expect(result.status).not.toBe('succeeded')
    expect(core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)?.status).toBe('completed')
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).not.toBe('rolled_back')
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it.each(['missing-source', 'current-attempt-source', 'transferred-temp'])('recovered intent rejects invalid %s provenance', async (scenario) => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    await core.executeRestore({ ...f, plan, hooks: { 'after-replace': () => { throw new Error('unrecorded applied action') } } })
    expect((await core.executeRestore({ ...f, plan })).status).toBe('succeeded')
    const journal = core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)!
    const owner = journal.attempts.find((a) => a.actions.some((entry) => entry.recoveredFromAttemptId))!
    const recovered = owner.actions.find((entry) => entry.recoveredFromAttemptId)!
    if (scenario === 'missing-source') recovered.recoveredFromAttemptId = 'missing-attempt'
    if (scenario === 'current-attempt-source') recovered.recoveredFromAttemptId = owner.id
    if (scenario === 'transferred-temp') recovered.tempPath = journal.attempts[0]!.actions[0]!.tempPath
    core.persistRestoreJournal(f.stateRoot, journal)
    expect(() => core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)).toThrow()
    expect(core.sessionAdmission(f.stateRoot, plan.workspaceId).eligible).toBe(false)
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('verified receipt never authorizes overwriting a later user edit, even back to Post', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const failed = await core.executeRestore({ ...f, plan, hooks: { 'after-verified': () => { throw new Error('stop after verified') } } })
    expect(failed.status).toBe('partial')
    const first = plan.actions[0]!
    const post = f.post.postManifest.files.find((r) => r.path === first.path)!
    const cas = new core.FSCasStore(f.stateRoot)
    writeFileSync(path.join(f.workspaceRoot, first.path), await cas.get(post.hash!))
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('pending recovery blocks new snapshots even if Session is tampered to ordinary failed', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    await core.executeRestore({ ...f, plan, hooks: { 'after-verified': () => { throw new Error('partial') } } })
    const session = core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId)
    core.persistSession(f.stateRoot, plan.workspaceId, { ...session, status: core.SessionStatus.Failed })
    expect(core.sessionAdmission(f.stateRoot, plan.workspaceId).eligible).toBe(false)
    const before = captureTree(f.workspaceRoot)
    await expect(core.createPreSnapshot(f)).rejects.toThrow()
    await expect(core.createPostSnapshot({ ...f, sessionId: plan.sessionId })).rejects.toThrow()
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('latest non-restorable Session never falls back to an earlier recoverable Session', async () => {
    const f = await restoreFixture()
    const latest = core.newSessionRecord({ workspaceId: f.pre.session.workspaceId, sessionId: 'later-session', agent: { kind: 'generic', command: 'fixture' } })
    latest.startedAt = new Date(Date.now() + 60_000).toISOString()
    latest.status = core.SessionStatus.Committed
    core.persistSession(f.stateRoot, latest.workspaceId, latest)
    const before = captureTree(f.workspaceRoot)
    await expect(core.prepareRestore(f)).rejects.toThrow()
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('Journal persistence failure stops before target writes and can retry without hiding the error', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const before = captureTree(f.workspaceRoot)
    const result = await core.executeRestore({ ...f, plan, hooks: { 'before-journal-write': () => { throw new Error('injected journal persistence failure') } } })
    expect(['rejected', 'retryable']).toContain(result.status)
    expect(result.error).toMatch(/journal persistence failure/)
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('succeeded')
  })

  it('corrupt persisted Journal fails closed without further target changes', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    await core.executeRestore({ ...f, plan, hooks: { 'after-intent': () => { throw new Error('pause') } } })
    writeFileSync(path.join(f.stateRoot, 'workspaces', plan.workspaceId, 'sessions', `${plan.sessionId}.journal.json`), '{broken')
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(core.sessionAdmission(f.stateRoot, plan.workspaceId).eligible).toBe(false)
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it.each(['preManifestRef', 'postManifestRef', 'policyDigest'] as const)('resealed plan with wrong %s still fails its source binding', async (field) => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    plan[field] = 'f'.repeat(64)
    const { planDigest: _digest, ...body } = plan
    plan.planDigest = core.restorePlanDigest(body)
    core.saveRestorePlan(f.stateRoot, plan.workspaceId, plan)
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('a resealed Journal cannot authorize deleting a foreign temporary file', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    await core.executeRestore({ ...f, plan, hooks: { 'temp-write': () => { throw new Error('pause with owned temp') } } })
    const journal = core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)!
    const sentinel = path.join(f.temporaryRoot, 'foreign-sentinel.txt')
    writeFileSync(sentinel, 'foreign data')
    journal.attempts[0]!.actions[0]!.tempPath = sentinel
    core.persistRestoreJournal(f.stateRoot, journal)
    await core.executeRestore({ ...f, plan })
    expect(readFileSync(sentinel, 'utf8')).toBe('foreign data')
  })

  it('rollback_failed without its Journal cannot start a fresh recovery attempt', async () => {
    const f = await restoreFixture()
    const session = core.loadSession(f.stateRoot, f.pre.session.workspaceId, f.pre.session.id)
    core.persistSession(f.stateRoot, session.workspaceId, { ...session, status: core.SessionStatus.RollbackFailed })
    const before = captureTree(f.workspaceRoot)
    await expect(core.prepareRestore(f)).rejects.toThrow()
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('unsupported persisted Manifest schema is rechecked at execution time', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    writeFileSync(core.manifestPath(f.stateRoot, plan.workspaceId, f.pre.manifest.id), JSON.stringify({ ...f.pre.manifest, schemaVersion: 999 }))
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('an unfinished Journal never makes an unknown Session status executable', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const session = core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId)
    writeFileSync(core.sessionPath(f.stateRoot, plan.workspaceId, plan.sessionId), JSON.stringify({ ...session, status: 'unknown-status' }))
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('a newer recoverable Session cannot bypass an older unfinished Journal', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    // Synthetic anomalous state: an unrelated older recovery was left behind.
    const olderId = 'older-pending-session'
    const older = { ...f.pre.session, id: olderId, startedAt: new Date(Date.now() - 60_000).toISOString(), status: core.SessionStatus.Failed }
    core.persistSession(f.stateRoot, plan.workspaceId, older)
    writeFileSync(core.restoreJournalPath(f.stateRoot, plan.workspaceId, olderId), '{corrupt older recovery journal')
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('Force requires explicit session, digest, conflict scope and unchanged Current binding', async () => {
    const f = await restoreFixture()
    writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user edit for deliberate force')
    const plan = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    expect(plan.force).toBe(false)
    expect(plan.conflicts.map((c) => c.path)).toEqual(['a-modified.txt'])
    expect(plan.conflicts[0]?.currentFingerprint).toBeTruthy()
    const authorization = {
      schemaVersion: 1 as const,
      sessionId: plan.sessionId,
      planDigest: plan.planDigest,
      conflicts: plan.conflicts.map((c) => ({ path: c.path, currentFingerprint: c.currentFingerprint! })),
    }
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect((await core.executeRestore({ ...f, plan, forceAuthorization: { ...authorization, planDigest: 'wrong' } })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    expect((await core.executeRestore({ ...f, plan, forceAuthorization: authorization })).status).toBe('succeeded')
    expect(readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'utf8')).toBe(f.original['a-modified.txt'])
    expect(readFileSync(path.join(f.workspaceRoot, 'outside-scope.txt'), 'utf8')).toBe('outside agent edit')
  })

  it('Force authorization expires when Current changes after authorization', async () => {
    const f = await restoreFixture()
    writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user edit 1')
    const plan = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    const authorization = { schemaVersion: 1 as const, sessionId: plan.sessionId, planDigest: plan.planDigest, conflicts: plan.conflicts.map((c) => ({ path: c.path, currentFingerprint: c.currentFingerprint! })) }
    writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user edit 2')
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan, forceAuthorization: authorization })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('valid Force authorization cannot bypass a corrupt CAS blob', async () => {
    const f = await restoreFixture()
    writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user conflict')
    const plan = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    const authorization = { schemaVersion: 1 as const, sessionId: plan.sessionId, planDigest: plan.planDigest, conflicts: plan.conflicts.map((c) => ({ path: c.path, currentFingerprint: c.currentFingerprint! })) }
    const hash = plan.actions[0]!.blobHash!
    writeFileSync(path.join(f.stateRoot, 'blobs', 'sha256', hash.slice(0, 2), hash.slice(2)), 'corrupt CAS')
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan, forceAuthorization: authorization })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
  })

  it('temporary file bytes are read back and verified before replacing the target', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    const before = readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'))
    let corrupted = false
    const result = await core.executeRestore({ ...f, plan, hooks: { 'temp-write': ({ tempPath }) => {
      if (!corrupted) { corrupted = true; writeFileSync(tempPath!, 'tampered temporary bytes') }
    } } })
    expect(corrupted).toBe(true)
    expect(result.status).not.toBe('succeeded')
    expect(readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'))).toEqual(before)
  })

  it('a new Current change at the last action guard stops subsequent actions', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    let fired = false
    const result = await core.executeRestore({ ...f, plan, hooks: { 'before-action': ({ action }) => {
      if (!fired) { fired = true; writeFileSync(path.join(f.workspaceRoot, action.path), 'racing user write') }
    } } })
    expect(fired).toBe(true)
    expect(['partial', 'retryable']).toContain(result.status)
    expect(readFileSync(path.join(f.workspaceRoot, plan.actions[0]!.path), 'utf8')).toBe('racing user write')
    expect(existsSync(path.join(f.workspaceRoot, 'z-created.txt'))).toBe(true)
  })

  it('a parent junction introduced after intent is rejected before even temporary target writes', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore({ ...f, scope: '中文 目录/文件 名.bin' })
    const outside = path.join(f.temporaryRoot, 'outside-after-intent')
    writeTree(outside, { '文件 名.bin': 'external sentinel' })
    const outsideBefore = captureTree(outside)
    const result = await core.executeRestore({ ...f, plan, hooks: { 'after-intent': async () => {
      const { rmdirSync } = await import('node:fs')
      const dir = path.join(f.workspaceRoot, '中文 目录')
      unlinkSync(path.join(dir, '文件 名.bin'))
      rmdirSync(dir)
      symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir')
    }, 'temp-write': () => { throw new Error('UNSAFE external temporary write reached') } } })
    expect(result.status).not.toBe('succeeded')
    expect(result.error).not.toMatch(/UNSAFE/)
    expect(captureTree(outside)).toEqual(outsideBefore)
  })

  it('substituting the workspace root itself with a junction cannot redirect restore writes', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    const outside = path.join(f.temporaryRoot, 'external-root-target')
    const savedRoot = path.join(f.temporaryRoot, 'original-root')
    writeTree(outside, { 'a-modified.txt': readFileSync(path.join(f.workspaceRoot, 'a-modified.txt')) })
    const before = captureTree(outside)
    const result = await core.executeRestore({ ...f, plan, hooks: { 'after-intent': async () => {
      const { renameSync } = await import('node:fs')
      expect(path.dirname(f.workspaceRoot)).toBe(f.temporaryRoot)
      expect(path.dirname(savedRoot)).toBe(f.temporaryRoot)
      renameSync(f.workspaceRoot, savedRoot)
      symlinkSync(outside, f.workspaceRoot, process.platform === 'win32' ? 'junction' : 'dir')
    } } })
    expect(result.status).not.toBe('succeeded')
    expect(captureTree(outside)).toEqual(before)
  })

  it('exclusive temporary creation failure never deletes the foreign occupying file', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore({ ...f, scope: 'a-modified.txt' })
    const targetBefore = readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'))
    let occupied = ''
    const result = await core.executeRestore({ ...f, plan, hooks: { 'after-intent': ({ tempPath }) => {
      occupied = tempPath!
      writeFileSync(occupied, 'foreign occupant', { flag: 'wx' })
    } } })
    expect(result.status).not.toBe('succeeded')
    expect(readFileSync(occupied, 'utf8')).toBe('foreign occupant')
    expect(readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'))).toEqual(targetBefore)
  })

  it('two same-process executors cannot overlap despite the existing reentrant lock helper', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    let resume!: () => void
    let announce!: () => void
    const paused = new Promise<void>((resolve) => { announce = resolve })
    const gate = new Promise<void>((resolve) => { resume = resolve })
    const first = core.executeRestore({ ...f, plan, hooks: { 'after-intent': async () => { announce(); await gate } } })
    await paused
    try {
      const second = await core.executeRestore({ ...f, plan })
      expect(second.status).toBe('rejected')
      expect(second.completedPaths).toEqual([])
    } finally { resume() }
    expect((await first).status).toBe('succeeded')
  })

  it('concurrent preparation never returns two different immutable Journal plans', async () => {
    const f = await restoreFixture()
    const preparations = await Promise.allSettled([core.prepareRestore(f), core.prepareRestore(f)])
    const plans = preparations.flatMap((r) => r.status === 'fulfilled' ? [r.value] : [])
    expect(plans.length).toBeGreaterThan(0)
    expect(new Set(plans.map((plan) => plan.planDigest)).size).toBe(1)
    expect(core.loadRestoreJournal(f.stateRoot, plans[0]!.workspaceId, plans[0]!.sessionId)?.planDigest).toBe(plans[0]!.planDigest)
    expect((await core.executeRestore({ ...f, plan: plans[0]! })).status).toBe('succeeded')
  })

  it('deleting a created junction removes only the link body and preserves its target', async () => {
    const f = await restoreFixture()
    // Reuse an unchanged synthetic external directory, then create a new fixture Session.
    const base = makeTempDir('agentcommit-p2b-created-link-')
    const workspaceRoot = path.join(base, 'workspace')
    mkdirSync(workspaceRoot)
    core.initializeWorkspace(workspaceRoot)
    const stateRoot = makeStateRoot(base)
    const pre = await core.createPreSnapshot({ workspaceRoot, stateRoot })
    const link = path.join(workspaceRoot, 'created-link')
    symlinkSync(f.workspaceRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
    await core.createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
    const targetBefore = captureTree(f.workspaceRoot)
    const plan = await core.prepareRestore({ workspaceRoot, stateRoot })
    const result = await core.executeRestore({ workspaceRoot, stateRoot, plan })
    expect(result.status, JSON.stringify({ result, plan })).toBe('succeeded')
    expect(existsSync(link)).toBe(false)
    expect(captureTree(f.workspaceRoot)).toEqual(targetBefore)
  })

  it('parent junction substituted after planning cannot touch its target', async () => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const dir = path.join(f.workspaceRoot, '中文 目录')
    unlinkSync(path.join(dir, '文件 名.bin'))
    // Remove only the known empty fixture directory, never a recursive delete.
    const { rmdirSync } = await import('node:fs')
    rmdirSync(dir)
    const outside = path.join(f.temporaryRoot, 'outside')
    mkdirSync(outside)
    writeTree(outside, { '文件 名.bin': 'external sentinel' })
    symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir')
    const before = captureTree(f.workspaceRoot)
    expect((await core.executeRestore({ ...f, plan })).status).toBe('rejected')
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    expect(readFileSync(path.join(outside, '文件 名.bin'), 'utf8')).toBe('external sentinel')
  })

  it('Unix rwx metadata is restored and verified; Windows makes no ACL promise', async () => {
    const f = await restoreFixture()
    const target = path.join(f.workspaceRoot, 'a-modified.txt')
    const plan = await core.prepareRestore(f)
    if (process.platform !== 'win32') chmodSync(target, 0o700)
    const result = await core.executeRestore({ ...f, plan })
    // A changed supported mode is a post-planning conflict; do not quietly overwrite it.
    if (process.platform !== 'win32') {
      expect(result.status).toBe('rejected')
      console.log('[P2B-platform] POSIX mode conflict branch verified')
    } else {
      expect(result.status).toBe('succeeded')
      expect(lstatSync(target).isFile()).toBe(true)
      console.log('[P2B-platform] Windows content restoration verified; POSIX chmod and ACL recovery not verified')
    }
  })

  it('restores and verifies Unix rwx bits without special bits (Unix only)', { skip: process.platform === 'win32' }, async () => {
    const base = makeTempDir('agentcommit-p2b-mode-')
    const workspaceRoot = path.join(base, 'workspace')
    writeTree(workspaceRoot, { 'executable.sh': 'echo original' })
    core.initializeWorkspace(workspaceRoot)
    const stateRoot = makeStateRoot(base)
    const file = path.join(workspaceRoot, 'executable.sh')
    chmodSync(file, 0o751)
    const pre = await core.createPreSnapshot({ workspaceRoot, stateRoot })
    chmodSync(file, 0o600)
    await core.createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
    const plan = await core.prepareRestore({ workspaceRoot, stateRoot })
    expect((await core.executeRestore({ workspaceRoot, stateRoot, plan })).status).toBe('succeeded')
    expect(lstatSync(file).mode & 0o777).toBe(0o751)
    expect(lstatSync(file).mode & 0o7000).toBe(0)
    console.log('[P2B-platform] Unix rwx 0751 restored and verified')
  })

  it('link restoration follows the declared platform support and never modifies link targets', async () => {
    const base = makeTempDir('agentcommit-p2b-link-')
    const workspaceRoot = path.join(base, 'workspace')
    const outside = path.join(base, 'outside')
    writeTree(outside, { 'sentinel.txt': 'target must remain untouched' })
    mkdirSync(workspaceRoot)
    core.initializeWorkspace(workspaceRoot)
    const link = path.join(workspaceRoot, 'link')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const target = readlinkSync(link)
    const stateRoot = makeStateRoot(base)
    const pre = await core.createPreSnapshot({ workspaceRoot, stateRoot })
    unlinkSync(link)
    await core.createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
    const plan = await core.prepareRestore({ workspaceRoot, stateRoot })
    const before = captureTree(workspaceRoot)
    const result = await core.executeRestore({ workspaceRoot, stateRoot, plan })
    if (process.platform === 'win32') {
      expect(result.status).toBe('rejected')
      expect(plan.blocked.length).toBeGreaterThan(0)
      expect(captureTree(workspaceRoot)).toEqual(before)
      console.log('[P2B-platform] Windows junction recreation explicitly blocked; external target unchanged')
    } else {
      expect(result.status).toBe('succeeded')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(target)
    }
    expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('target must remain untouched')
  })

  describe('OQ-07 mode restore regression matrix (POSIX only; Windows keeps content-only semantics)', () => {
    const isWin = process.platform === 'win32'
    const skipWin = isWin ? 'Windows makes no ACL promise; content-only verified in the suite above' : false

    it('content restore keeps a 0751 pre mode (no widening to 0644)', { skip: skipWin }, async () => {
      const base = makeTempDir('agentcommit-p2b-mode0751-')
      const workspaceRoot = path.join(base, 'workspace')
      writeTree(workspaceRoot, { 'tool.sh': 'echo original\n' })
      core.initializeWorkspace(workspaceRoot)
      const stateRoot = makeStateRoot(base)
      const file = path.join(workspaceRoot, 'tool.sh')
      chmodSync(file, 0o751)
      const pre = await core.createPreSnapshot({ workspaceRoot, stateRoot })
      chmodSync(file, 0o600)
      writeFileSync(file, 'echo modified\n') // content AND mode both changed
      await core.createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
      const plan = await core.prepareRestore({ workspaceRoot, stateRoot })
      expect((await core.executeRestore({ workspaceRoot, stateRoot, plan })).status).toBe('succeeded')
      expect(readFileSync(file, 'utf8')).toBe('echo original\n')
      expect(lstatSync(file).mode & 0o777).toBe(0o751)
    })

    it('a 0600 pre mode is restored, never silently widened to the default 0644', { skip: skipWin }, async () => {
      const base = makeTempDir('agentcommit-p2b-mode0600-')
      const workspaceRoot = path.join(base, 'workspace')
      writeTree(workspaceRoot, { 'secret.cfg': 'token-ish\n' })
      core.initializeWorkspace(workspaceRoot)
      const stateRoot = makeStateRoot(base)
      const file = path.join(workspaceRoot, 'secret.cfg')
      chmodSync(file, 0o600)
      const pre = await core.createPreSnapshot({ workspaceRoot, stateRoot })
      chmodSync(file, 0o644)
      writeFileSync(file, 'leaked\n')
      await core.createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
      const plan = await core.prepareRestore({ workspaceRoot, stateRoot })
      expect((await core.executeRestore({ workspaceRoot, stateRoot, plan })).status).toBe('succeeded')
      expect(readFileSync(file, 'utf8')).toBe('token-ish\n')
      expect(lstatSync(file).mode & 0o777).toBe(0o600)
    })

    it('a mode-only change (content identical) is recognized and restored', { skip: skipWin }, async () => {
      const base = makeTempDir('agentcommit-p2b-modeonly-')
      const workspaceRoot = path.join(base, 'workspace')
      writeTree(workspaceRoot, { 'bin/x': '#!/bin/sh\necho hi\n' })
      core.initializeWorkspace(workspaceRoot)
      const stateRoot = makeStateRoot(base)
      const file = path.join(workspaceRoot, 'bin/x')
      chmodSync(file, 0o644)
      const pre = await core.createPreSnapshot({ workspaceRoot, stateRoot })
      chmodSync(file, 0o755)
      await core.createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
      const plan = await core.prepareRestore({ workspaceRoot, stateRoot })
      expect(plan.actions.some((a) => a.type === 'restore-metadata' && a.path === 'bin/x')).toBe(true)
      expect((await core.executeRestore({ workspaceRoot, stateRoot, plan })).status).toBe('succeeded')
      expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho hi\n')
      expect(lstatSync(file).mode & 0o777).toBe(0o644)
    })

    it('a chmod AFTER planning is a mode-drift conflict, refused with zero target writes', { skip: skipWin }, async () => {
      const base = makeTempDir('agentcommit-p2b-modepostplan-')
      const workspaceRoot = path.join(base, 'workspace')
      writeTree(workspaceRoot, { 'f.txt': 'v1\n' })
      core.initializeWorkspace(workspaceRoot)
      const stateRoot = makeStateRoot(base)
      const file = path.join(workspaceRoot, 'f.txt')
      chmodSync(file, 0o644)
      const pre = await core.createPreSnapshot({ workspaceRoot, stateRoot })
      chmodSync(file, 0o755)
      writeFileSync(file, 'v2\n')
      await core.createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
      const plan = await core.prepareRestore({ workspaceRoot, stateRoot })
      chmodSync(file, 0o700) // post-planning chmod
      const before = readFileSync(file, 'utf8')
      const result = await core.executeRestore({ workspaceRoot, stateRoot, plan })
      expect(result.status).toBe('rejected')
      expect(result.conflicts.some((c) => /mode/i.test(c.message))).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(before)
    })

    it('an explicit-mode manifest never false-conflicts on a clean restore', { skip: skipWin }, async () => {
      const base = makeTempDir('agentcommit-p2b-modeexplicit-')
      const workspaceRoot = path.join(base, 'workspace')
      writeTree(workspaceRoot, { 'a.sh': 'echo a\n' })
      core.initializeWorkspace(workspaceRoot)
      const stateRoot = makeStateRoot(base)
      const file = path.join(workspaceRoot, 'a.sh')
      chmodSync(file, 0o755)
      const pre = await core.createPreSnapshot({ workspaceRoot, stateRoot })
      chmodSync(file, 0o644)
      writeFileSync(file, 'echo b\n')
      await core.createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
      const manifest = core.loadManifest(stateRoot, pre.session.workspaceId, pre.session.preManifestRef)
      const record = manifest.files.find((f) => f.path === 'a.sh')
      expect(record?.mode).toBe(0o755) // scanner recorded the explicit mode
      const plan = await core.prepareRestore({ workspaceRoot, stateRoot })
      expect(plan.conflicts).toEqual([])
      expect((await core.executeRestore({ workspaceRoot, stateRoot, plan })).status).toBe('succeeded')
      expect(lstatSync(file).mode & 0o777).toBe(0o755)
    })
  })

})