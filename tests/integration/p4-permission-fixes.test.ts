// R1/R2/R3 regression tests (permission limited-fix round). POSIX cases run on CI;
// Windows keeps content-level and no-regression coverage.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createPostSnapshot, createPreSnapshot, executeRestore, initializeWorkspace, loadManifest,
  loadRestoreJournal, loadSession, prepareRestore, FSCasStore,
} from '@agentcommit/core'
import { makeStateRoot, makeTempDir } from '../helpers.js'

const repo = path.resolve(import.meta.dirname, '../..')
beforeAll(() => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/core/tsconfig.json`], { cwd: repo })
}, 30_000)

const isWin = process.platform === 'win32'
const skipPosix = isWin ? 'POSIX permission semantics not applicable on Windows (no ACL promise)' : false
function fresh(name) {
  const tmp = makeTempDir(`agentcommit-p4-permfix-${name}-`)
  const ws = path.join(tmp, 'workspace')
  mkdirSync(ws, { recursive: true })
  initializeWorkspace(ws)
  const stateRoot = makeStateRoot(tmp)
  const workspaceId = JSON.parse(readFileSync(path.join(ws, '.agentcommit.json'), 'utf8')).workspaceId
  return { tmp, ws, stateRoot, workspaceId }
}
function stripModeFile(stateRoot, workspaceId, manifestId) {
  const p = path.join(stateRoot, 'workspaces', workspaceId, 'manifests', `${manifestId}.json`)
  const raw = JSON.parse(readFileSync(p, 'utf8'))
  for (const rec of raw.files ?? []) delete rec.mode
  writeFileSync(p, JSON.stringify(raw, null, 2))
}

describe('R1 scanner: content and mode from the same accepted read', () => {
  it('stable read records mode as-is', { skip: skipPosix }, async () => {
    const f = fresh('stable')
    writeFileSync(path.join(f.ws, 'x.txt'), 'content-a\n')
    chmodSync(path.join(f.ws, 'x.txt'), 0o644)
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    const rec = loadManifest(f.stateRoot, f.workspaceId, pre.manifest.id).files.find(r => r.path === 'x.txt')
    expect(rec.mode).toBe(0o644)
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('mid-read 0644->0600 content mutation: retry records new content WITH 0600 and restores 0600', { skip: skipPosix }, async () => {
    const f = fresh('retry-mode')
    const file = path.join(f.ws, 'target.txt')
    writeFileSync(file, 'content-A\n')
    chmodSync(file, 0o644)
    class MutateOnce extends FSCasStore {
      private fired = false
      protected override beforeStableReadVerify = (filePath) => {
        if (this.fired || !filePath.endsWith('target.txt')) return
        this.fired = true
        writeFileSync(file, 'content-B-longer\n')
        chmodSync(file, 0o600)
      }
    }
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, cas: new MutateOnce(f.stateRoot) })
    const preRec = loadManifest(f.stateRoot, f.workspaceId, pre.manifest.id).files.find(r => r.path === 'target.txt')
    expect(preRec.hash).toBeTruthy()
    expect(preRec.mode).toBe(0o600) // NOT the stale 0644 from the failed attempt
    await createPostSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, sessionId: pre.session.id })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked).toEqual([])
    expect((await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })).status).toBe('succeeded')
    expect(readFileSync(file, 'utf8')).toBe('content-B-longer\n')
    expect(lstatSync(file).mode & 0o777).toBe(0o600)
    expect(loadRestoreJournal(f.stateRoot, f.workspaceId, pre.session.id)?.status).toBe('completed')
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('a persistently mutating read fails closed with FILE_CHANGED_DURING_SNAPSHOT', { skip: skipPosix }, async () => {
    const f = fresh('persist')
    const file = path.join(f.ws, 'flaky.txt')
    writeFileSync(file, 'v0\n')
    chmodSync(file, 0o644)
    class MutateAlways extends FSCasStore {
      private n = 0
      protected override beforeStableReadVerify = (filePath) => {
        if (!filePath.endsWith('flaky.txt')) return
        this.n += 1
        writeFileSync(file, `v${this.n}-longer\n`)
        chmodSync(file, 0o600)
      }
    }
    await expect(createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, cas: new MutateAlways(f.stateRoot) }))
      .rejects.toMatchObject({ code: 'FILE_CHANGED_DURING_SNAPSHOT' })
    rmSync(f.tmp, { recursive: true, force: true })
  })
})

describe('R2 legacy manifests without mode evidence: conservative pre-write block', () => {
  async function legacyFixture(name, stripWhich) {
    const f = fresh(name)
    writeFileSync(path.join(f.ws, 'f.txt'), 'v1\n')
    chmodSync(path.join(f.ws, 'f.txt'), 0o600)
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    if (stripWhich === 'pre') stripModeFile(f.stateRoot, f.workspaceId, pre.manifest.id)
    writeFileSync(path.join(f.ws, 'f.txt'), 'v2\n')
    chmodSync(path.join(f.ws, 'f.txt'), 0o644)
    const post = await createPostSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, sessionId: pre.session.id })
    if (stripWhich === 'both') {
      stripModeFile(f.stateRoot, f.workspaceId, pre.manifest.id)
      stripModeFile(f.stateRoot, f.workspaceId, post.postManifest.id)
    }
    if (stripWhich === 'post') stripModeFile(f.stateRoot, f.workspaceId, post.postManifest.id)
    return { f, pre, post }
  }

  it('both Pre and Post missing mode: blocked pre-write, file content and mode untouched', { skip: skipPosix }, async () => {
    const { f } = await legacyFixture('both', 'both')
    const before = readFileSync(path.join(f.ws, 'f.txt'), 'utf8')
    const beforeMode = lstatSync(path.join(f.ws, 'f.txt')).mode & 0o777
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked.some(b => b.path === 'f.txt' && /rwx evidence/.test(b.reason))).toBe(true)
    const outcome = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    // executeRestore reports a blocked plan as a RESOLVED 'rejected' result (the
    // P2-A contract — it never throws for a blocked plan). The refusal must name
    // the blocked/unverified cause, and nothing may be written.
    expect(outcome.status).toBe('rejected')
    expect(outcome.error).toMatch(/blocked|unsupported/i)
    expect(readFileSync(path.join(f.ws, 'f.txt'), 'utf8')).toBe(before)
    expect(lstatSync(path.join(f.ws, 'f.txt')).mode & 0o777).toBe(beforeMode)
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('Pre missing mode, Post present: blocked pre-write, nothing written', { skip: skipPosix }, async () => {
    const { f } = await legacyFixture('premissing', 'pre')
    const before = readFileSync(path.join(f.ws, 'f.txt'), 'utf8')
    const beforeMode = lstatSync(path.join(f.ws, 'f.txt')).mode & 0o777
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked.some(b => b.path === 'f.txt' && /rwx evidence/.test(b.reason))).toBe(true)
    const outcome = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    // executeRestore reports a blocked plan as a RESOLVED 'rejected' result (the
    // P2-A contract — it never throws for a blocked plan). The refusal must name
    // the blocked/unverified cause, and nothing may be written.
    expect(outcome.status).toBe('rejected')
    expect(outcome.error).toMatch(/blocked|unsupported/i)
    expect(readFileSync(path.join(f.ws, 'f.txt'), 'utf8')).toBe(before)
    expect(lstatSync(path.join(f.ws, 'f.txt')).mode & 0o777).toBe(beforeMode)
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('legacy deleted path with missing Pre mode stays DELETED (no 0644 recreation)', { skip: skipPosix }, async () => {
    const f = fresh('deleted')
    writeFileSync(path.join(f.ws, 'gone.txt'), 'original\n')
    chmodSync(path.join(f.ws, 'gone.txt'), 0o600)
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    stripModeFile(f.stateRoot, f.workspaceId, pre.manifest.id)
    rmSync(path.join(f.ws, 'gone.txt'))
    await createPostSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, sessionId: pre.session.id })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked.some(b => b.path === 'gone.txt' && /rwx evidence/.test(b.reason))).toBe(true)
    const outcome = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    // executeRestore reports a blocked plan as a RESOLVED 'rejected' result (the
    // P2-A contract — it never throws for a blocked plan). The refusal must name
    // the blocked/unverified cause, and nothing may be written.
    expect(outcome.status).toBe('rejected')
    expect(outcome.error).toMatch(/blocked|unsupported/i)
    expect(readdirSync(f.ws).includes('gone.txt')).toBe(false)
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('normal new manifests still restore and their Journal formally reloads (control)', { skip: skipPosix }, async () => {
    const f = fresh('control')
    writeFileSync(path.join(f.ws, 'c.txt'), 'v1\n')
    chmodSync(path.join(f.ws, 'c.txt'), 0o751)
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    writeFileSync(path.join(f.ws, 'c.txt'), 'v2\n')
    chmodSync(path.join(f.ws, 'c.txt'), 0o600)
    await createPostSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, sessionId: pre.session.id })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked).toEqual([])
    expect((await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })).status).toBe('succeeded')
    expect(lstatSync(path.join(f.ws, 'c.txt')).mode & 0o777).toBe(0o751)
    expect(loadRestoreJournal(f.stateRoot, f.workspaceId, pre.session.id)?.status).toBe('completed')
    rmSync(f.tmp, { recursive: true, force: true })
  })
})

describe('R2b: Post-mode evidence gates the whole selected scope before any write (POSIX only)', () => {
  function stripModeFor(stateRoot, workspaceId, manifestId, relPath) {
    const p = path.join(stateRoot, 'workspaces', workspaceId, 'manifests', `${manifestId}.json`)
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const rec = (raw.files ?? []).find(r => r.path === relPath)
    if (!rec) throw new Error('no manifest record for ' + relPath)
    delete rec.mode
    writeFileSync(p, JSON.stringify(raw, null, 2))
  }
  function captureState(ws) {
    const out = {}
    for (const name of readdirSync(ws).sort()) {
      const p = path.join(ws, name)
      out[name] = { bytes: readFileSync(p, 'utf8'), mode: '0' + (lstatSync(p).mode & 0o777).toString(8) }
    }
    return out
  }
  async function postGapFixture(name, { created = false, stripPost = true } = {}) {
    const f = fresh(`postgap-${name}`)
    writeFileSync(path.join(f.ws, 'a-known.txt'), 'PRE-a\n')
    chmodSync(path.join(f.ws, 'a-known.txt'), 0o600)
    if (!created) {
      writeFileSync(path.join(f.ws, 'z-gap.txt'), 'PRE-z\n')
      chmodSync(path.join(f.ws, 'z-gap.txt'), 0o600)
    }
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    writeFileSync(path.join(f.ws, 'a-known.txt'), 'POST-a\n')
    chmodSync(path.join(f.ws, 'a-known.txt'), 0o644)
    writeFileSync(path.join(f.ws, 'z-gap.txt'), 'POST-z\n')
    chmodSync(path.join(f.ws, 'z-gap.txt'), 0o644)
    const post = await createPostSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, sessionId: pre.session.id })
    if (stripPost) stripModeFor(f.stateRoot, f.workspaceId, post.postManifest.id, 'z-gap.txt')
    return { f, pre, post }
  }

  it('modified regular file whose Post record lacks mode: blocked before ANY selected write; scope untouched; retry stays refused (not retryable)', { skip: skipPosix }, async () => {
    const { f, pre } = await postGapFixture('modified')
    const before = captureState(f.ws)
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked.some(b => b.path === 'z-gap.txt' && /Post manifest has no rwx evidence/.test(b.reason))).toBe(true)
    const outcome = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    expect(outcome.status).toBe('rejected')
    expect(outcome.error).toMatch(/blocked|unsupported/i)
    expect(captureState(f.ws)).toEqual(before)
    expect(loadSession(f.stateRoot, f.workspaceId, pre.session.id).status).toBe('review')
    const retry = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    expect(retry.status).toBe('rejected')
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('created regular file whose Post record lacks mode: its delete-path is blocked before any write', { skip: skipPosix }, async () => {
    const { f, pre } = await postGapFixture('created', { created: true })
    const before = captureState(f.ws)
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked.some(b => b.path === 'z-gap.txt' && /Post manifest has no rwx evidence/.test(b.reason))).toBe(true)
    const outcome = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    expect(outcome.status).toBe('rejected')
    expect(captureState(f.ws)).toEqual(before)
    expect(loadSession(f.stateRoot, f.workspaceId, pre.session.id).status).toBe('review')
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('mixed plan (normal file planned first, evidence gap later): zero selected writes, no partial journal', { skip: skipPosix }, async () => {
    const { f, pre } = await postGapFixture('mixed')
    const before = captureState(f.ws)
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.actions.map(a => a.path)).toContain('a-known.txt')
    const outcome = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    expect(outcome.status).toBe('rejected')
    const after = captureState(f.ws)
    expect(after['a-known.txt']).toEqual(before['a-known.txt'])
    expect(after['z-gap.txt']).toEqual(before['z-gap.txt'])
    expect(loadSession(f.stateRoot, f.workspaceId, pre.session.id).status).toBe('review')
    expect(loadRestoreJournal(f.stateRoot, f.workspaceId, pre.session.id)?.attempts.length).toBe(0)
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('control: new-format modified+created+deleted still restores fully with modes verified', { skip: skipPosix }, async () => {
    const f = fresh('postgap-control')
    writeFileSync(path.join(f.ws, 'mod.txt'), 'PRE-mod\n')
    chmodSync(path.join(f.ws, 'mod.txt'), 0o600)
    writeFileSync(path.join(f.ws, 'gone.txt'), 'PRE-gone\n')
    chmodSync(path.join(f.ws, 'gone.txt'), 0o751)
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    writeFileSync(path.join(f.ws, 'mod.txt'), 'POST-mod\n')
    chmodSync(path.join(f.ws, 'mod.txt'), 0o644)
    writeFileSync(path.join(f.ws, 'new.txt'), 'CREATED\n')
    chmodSync(path.join(f.ws, 'new.txt'), 0o600)
    rmSync(path.join(f.ws, 'gone.txt'))
    await createPostSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, sessionId: pre.session.id })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked).toEqual([])
    expect((await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })).status).toBe('succeeded')
    expect(readFileSync(path.join(f.ws, 'mod.txt'), 'utf8')).toBe('PRE-mod\n')
    expect(lstatSync(path.join(f.ws, 'mod.txt')).mode & 0o777).toBe(0o600)
    expect(existsSync(path.join(f.ws, 'new.txt'))).toBe(false)
    expect(readFileSync(path.join(f.ws, 'gone.txt'), 'utf8')).toBe('PRE-gone\n')
    expect(lstatSync(path.join(f.ws, 'gone.txt')).mode & 0o777).toBe(0o751)
    expect(loadRestoreJournal(f.stateRoot, f.workspaceId, pre.session.id)?.status).toBe('completed')
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('out-of-scope evidence gap does not block a legal scoped restore', { skip: skipPosix }, async () => {
    const { f } = await postGapFixture('scope')
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, scope: 'a-known.txt' })
    expect(plan.blocked).toEqual([])
    expect((await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })).status).toBe('succeeded')
    expect(readFileSync(path.join(f.ws, 'a-known.txt'), 'utf8')).toBe('PRE-a\n')
    expect(lstatSync(path.join(f.ws, 'a-known.txt')).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(f.ws, 'z-gap.txt'), 'utf8')).toBe('POST-z\n')
    expect(lstatSync(path.join(f.ws, 'z-gap.txt')).mode & 0o777).toBe(0o644)
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('new-format post-plan chmod is still refused and nothing is written (drift check unchanged)', { skip: skipPosix }, async () => {
    const { f } = await postGapFixture('drift', { stripPost: false })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    expect(plan.blocked).toEqual([])
    chmodSync(path.join(f.ws, 'a-known.txt'), 0o700)
    const outcome = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    expect(outcome.status).toBe('rejected')
    expect(readFileSync(path.join(f.ws, 'a-known.txt'), 'utf8')).toBe('POST-a\n')
    expect(lstatSync(path.join(f.ws, 'a-known.txt')).mode & 0o777).toBe(0o700)
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('resumed journal whose remaining plan lost Post evidence: refused accurately, prior history preserved', { skip: skipPosix }, async () => {
    const { f, pre, post } = await postGapFixture('resume', { stripPost: false })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    let verified = 0
    const failed = await executeRestore({
      workspaceRoot: f.ws, stateRoot: f.stateRoot, plan,
      hooks: { 'after-verified': () => { if (verified++ === 0) throw new Error('stop after first action') } },
    })
    expect(failed.status).toBe('partial')
    stripModeFor(f.stateRoot, f.workspaceId, post.postManifest.id, 'z-gap.txt')
    const resumed = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    expect(resumed.status).toBe('rejected')
    expect(resumed.error).toMatch(/z-gap\.txt/)
    expect(resumed.error).toMatch(/rwx evidence/)
    expect(resumed.error).toMatch(/a-known\.txt/)
    expect(resumed.error).toMatch(/historical record, not re-checked against Current/)
    expect(resumed.error).not.toMatch(/no selected target has been written yet/)
    const journal = loadRestoreJournal(f.stateRoot, f.workspaceId, pre.session.id)
    expect(journal.attempts.some(a => a.actions.some(x => x.status === 'verified' && x.path === 'a-known.txt'))).toBe(true)
    expect(journal.status).toBe('partial')
    expect(readFileSync(path.join(f.ws, 'a-known.txt'), 'utf8')).toBe('PRE-a\n')
    expect(readFileSync(path.join(f.ws, 'z-gap.txt'), 'utf8')).toBe('POST-z\n')
    expect(lstatSync(path.join(f.ws, 'z-gap.txt')).mode & 0o777).toBe(0o644)
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('resumed journal whose earlier action took effect at after-replace (intent only): refusal names the intent and never claims zero historical writes', { skip: skipPosix }, async () => {
    const { f, pre, post } = await postGapFixture('intent', { stripPost: false })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    let replaced = 0
    const failed = await executeRestore({
      workspaceRoot: f.ws, stateRoot: f.stateRoot, plan,
      hooks: { 'after-replace': () => { if (replaced++ === 0) throw new Error('stop after replace') } },
    })
    expect(failed.status).toBe('retryable')
    // The replace DID take effect on disk; the Journal only carries an intent.
    expect(readFileSync(path.join(f.ws, 'a-known.txt'), 'utf8')).toBe('PRE-a\n')
    expect(lstatSync(path.join(f.ws, 'a-known.txt')).mode & 0o777).toBe(0o600)
    const journal = loadRestoreJournal(f.stateRoot, f.workspaceId, pre.session.id)
    expect(journal.attempts.some(a => a.actions.some(x => x.path === 'a-known.txt' && x.status === 'intent'))).toBe(true)
    expect(journal.attempts.some(a => a.actions.some(x => x.status === 'verified'))).toBe(false)
    stripModeFor(f.stateRoot, f.workspaceId, post.postManifest.id, 'z-gap.txt')
    const journalBefore = JSON.stringify(loadRestoreJournal(f.stateRoot, f.workspaceId, pre.session.id))
    const stateBefore = captureState(f.ws)
    const resumed = await executeRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot, plan })
    expect(resumed.status).toBe('rejected')
    expect(resumed.error).toMatch(/z-gap\.txt/)
    expect(resumed.error).toMatch(/rwx evidence/)
    expect(resumed.error).toMatch(/a-known\.txt/)
    expect(resumed.error).toMatch(/unfinished intents/)
    expect(resumed.error).toMatch(/may have already taken effect/)
    expect(resumed.error).not.toMatch(/no selected target has been written yet/)
    expect(captureState(f.ws)).toEqual(stateBefore)
    expect(JSON.stringify(loadRestoreJournal(f.stateRoot, f.workspaceId, pre.session.id))).toBe(journalBefore)
    rmSync(f.tmp, { recursive: true, force: true })
  })
})
describe('R3 temp-file permissions', () => {
  it('temp file stays 0600 during temp-write for a 0600 target; final restore is 0600', { skip: skipPosix }, async () => {
    const f = fresh('temp0600')
    writeFileSync(path.join(f.ws, 'secret.cfg'), 'old-secret\n')
    chmodSync(path.join(f.ws, 'secret.cfg'), 0o600)
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    writeFileSync(path.join(f.ws, 'secret.cfg'), 'new-secret-longer\n')
    chmodSync(path.join(f.ws, 'secret.cfg'), 0o644)
    await createPostSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, sessionId: pre.session.id })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    const tempModes = []
    const result = await executeRestore({
      workspaceRoot: f.ws, stateRoot: f.stateRoot, plan,
      hooks: { 'temp-write': (ctx) => { if (ctx.tempPath) tempModes.push(lstatSync(ctx.tempPath).mode & 0o777) } },
    })
    expect(result.status).toBe('succeeded')
    expect(tempModes.length).toBeGreaterThan(0)
    for (const m of tempModes) expect(m).toBe(0o600)
    expect(lstatSync(path.join(f.ws, 'secret.cfg')).mode & 0o777).toBe(0o600)
    expect(readFileSync(path.join(f.ws, 'secret.cfg'), 'utf8')).toBe('old-secret\n')
    rmSync(f.tmp, { recursive: true, force: true })
  })

  it('an interrupted temp-write leaves a conservative 0600 temp file behind', { skip: skipPosix }, async () => {
    const f = fresh('tempinterrupt')
    writeFileSync(path.join(f.ws, 's.txt'), 'old\n')
    chmodSync(path.join(f.ws, 's.txt'), 0o600)
    const pre = await createPreSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    writeFileSync(path.join(f.ws, 's.txt'), 'new-longer\n')
    chmodSync(path.join(f.ws, 's.txt'), 0o644)
    await createPostSnapshot({ workspaceRoot: f.ws, stateRoot: f.stateRoot, sessionId: pre.session.id })
    const plan = await prepareRestore({ workspaceRoot: f.ws, stateRoot: f.stateRoot })
    const seen = []
    const result = await executeRestore({
      workspaceRoot: f.ws, stateRoot: f.stateRoot, plan,
      hooks: { 'temp-write': (ctx) => { if (ctx.tempPath) seen.push(ctx.tempPath); throw new Error('interrupt at temp-write') } },
    }).catch(() => null)
    void result
    for (const tp of seen) {
      if (!tp || !existsSync(tp)) continue
      const st = lstatSync(tp)
      // The executor removes its own temp during abort cleanup; when a temp is
      // still present after an abort (e.g. a hard kill before cleanup ran) it
      // must never be wider than 0600.
      expect(st.mode & 0o777).toBe(0o600)
    }
    rmSync(f.tmp, { recursive: true, force: true })
  })
})
