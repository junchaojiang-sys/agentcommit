import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  classifyAbandonment, createPreSnapshot, initializeWorkspace, listWorkspaceSessions,
  loadManifest, locksDir, newSessionRecord, persistSession,
  resolveSessionAbandon, sessionAdmission,
} from '@agentcommit/core'
import { makeStateRoot, makeTempDir } from '../helpers.js'

const repo = path.resolve(import.meta.dirname, '../..')
const cli = path.join(repo, 'packages/cli/dist/index.js')
beforeAll(() => {
  for (const name of ['core', 'adapters', 'cli']) {
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/${name}/tsconfig.json`], { cwd: repo })
  }
}, 30_000)

interface Env { tmp: string; ws: string; stateRoot: string; workspaceId: string }

function fresh(name: string): Env {
  const tmp = makeTempDir(`agentcommit-p4-resolve-${name}-`)
  const ws = path.join(tmp, 'ws')
  const stateRoot = makeStateRoot(tmp)
  mkdirSync(ws, { recursive: true })
  initializeWorkspace(ws)
  const workspaceId = JSON.parse(readFileSync(path.join(ws, '.agentcommit.json'), 'utf8')).workspaceId
  return { tmp, ws, stateRoot, workspaceId }
}
function invoke(ws: string, stateRoot: string, args: string[], timeout = 30_000) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: ws, encoding: 'utf8', timeout,
    env: { ...process.env, AGENTCOMMIT_STATE_DIR: stateRoot } })
}
function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
}
const declaration = () => ({ taskStoppedConfirmed: true, confirmedAt: new Date().toISOString() })

/** Craft the crashed-wrapper state: a REAL pre snapshot, session forced to running, stale local lock. */
async function crashedFixture(env: Env, files: Record<string, string>) {
  writeTree(env.ws, files)
  const pre = await createPreSnapshot({ workspaceRoot: env.ws, stateRoot: env.stateRoot, agent: { kind: 'generic', command: 'synthetic' } })
  const session = pre.session
  expect(session.preManifestRef).toBeTruthy()
  persistSession(env.stateRoot, env.workspaceId, { ...session, status: 'running' })
  mkdirSync(locksDir(env.stateRoot), { recursive: true })
  writeFileSync(path.join(locksDir(env.stateRoot), `${env.workspaceId}.lock`), JSON.stringify({
    workspaceId: env.workspaceId, sessionId: session.id, pid: 99999999,
    hostname: os.hostname(), processStartedAt: 0, createdAt: new Date().toISOString(), agentCommand: 'dead-wrapper-probe',
  }))
  return session
}

describe('P4 resolve --abandon (crashed-running disposition)', () => {
  it('legitimate crashed session: abandons with proved-dead pid evidence, preserves files and evidence, releases lock, and a new run builds its baseline from the current file state', async () => {
    const env = fresh('legit')
    const session = await crashedFixture(env, { 'app.txt': 'half-written-by-agent', 'keep.txt': 'keep' })
    const before = readFileSync(path.join(env.ws, 'app.txt'), 'utf8')
    const result = await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() })
    expect(result.alreadyAbandoned).toBe(false)
    expect(result.session.status).toBe('abandoned')
    expect(result.resolution.kind).toBe('abandoned')
    expect(result.resolution.pidEvidence).toBe('proved-dead-local')
    expect(result.resolution.userDeclaration.childStopProven).toBe(false)
    expect(result.lockReleased).toBe(true)
    expect(readFileSync(path.join(env.ws, 'app.txt'), 'utf8')).toBe(before)
    expect(loadManifest(env.stateRoot, env.workspaceId, result.resolution.preManifestRef)).toBeTruthy()
    expect(sessionAdmission(env.stateRoot, env.workspaceId).eligible).toBe(true)
    // a NEW session builds its Pre from the CURRENT file state (the half-written file is the new baseline)
    writeFileSync(path.join(env.ws, 'next.txt'), 'next')
    const run = invoke(env.ws, env.stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('next.txt','next-edited')"])
    expect(run.status, run.stderr).toBe(0)
    const sessions = listWorkspaceSessions({ workspaceRoot: env.ws, stateRoot: env.stateRoot })
    const newest = sessions[0]
    expect(newest.id).not.toBe(session.id)
    expect(newest.status).toBe('review')
    const pre = loadManifest(env.stateRoot, env.workspaceId, newest.preManifestRef!)
    const appRecord = (pre.files as Array<{ path: string; hash: string }>).find(f => f.path === 'app.txt')
    expect(appRecord).toBeTruthy()
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('refuses without the operator declaration (declaration gate)', async () => {
    const env = fresh('nodecl')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    await expect(resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id,
      userDeclaration: { taskStoppedConfirmed: false, confirmedAt: new Date().toISOString() } }))
      .rejects.toThrow(/operator declaration/)
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('CLI refuses non-interactive invocation (no bypass)', async () => {
    const env = fresh('noninteractive')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    const r = invoke(env.ws, env.stateRoot, ['resolve', '--session', session.id, '--abandon'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('interactive-only')
    const still = listWorkspaceSessions({ workspaceRoot: env.ws, stateRoot: env.stateRoot })[0]
    expect(still.status).toBe('running')
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('refuses while a live local process holds the lock', async () => {
    const env = fresh('alive')
    writeFileSync(path.join(env.ws, 'a.txt'), 'x')
    const pre = await createPreSnapshot({ workspaceRoot: env.ws, stateRoot: env.stateRoot, agent: { kind: 'generic', command: 'synthetic' } })
    persistSession(env.stateRoot, env.workspaceId, { ...pre.session, status: 'running' })
    mkdirSync(locksDir(env.stateRoot), { recursive: true })
    // This test process is a definitely-live local holder.
    writeFileSync(path.join(locksDir(env.stateRoot), `${env.workspaceId}.lock`), JSON.stringify({
      workspaceId: env.workspaceId, sessionId: pre.session.id, pid: process.pid,
      hostname: os.hostname(), processStartedAt: 0, createdAt: new Date().toISOString(),
    }))
    const classification = classifyAbandonment({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: pre.session.id })
    expect(classification.eligible).toBe(false)
    expect(classification.pidEvidence).toBe('holder-alive')
    await expect(resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: pre.session.id, userDeclaration: declaration() }))
      .rejects.toThrow(/live local process/)
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('refuses a foreign-host lock', async () => {
    const env = fresh('foreign')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    writeFileSync(path.join(locksDir(env.stateRoot), `${env.workspaceId}.lock`), JSON.stringify({
      workspaceId: env.workspaceId, sessionId: session.id, pid: 1,
      hostname: 'another-host', processStartedAt: 0, createdAt: new Date().toISOString(),
    }))
    await expect(resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() }))
      .rejects.toThrow(/another host/)
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('refuses when a restore journal exists for the target (unfinished or unreadable)', async () => {
    const env = fresh('journal')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    const journalPath = path.join(env.stateRoot, 'workspaces', env.workspaceId, 'sessions', `${session.id}.journal.json`)
    writeFileSync(journalPath, '{}') // presence alone makes abandon impossible
    await expect(resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() }))
      .rejects.toThrow(/journal/i)
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('refuses a running session without a Pre manifest (unexplainable state stays fail-closed)', async () => {
    const env = fresh('nopre')
    const running = newSessionRecord({ sessionId: randomUUID(), workspaceId: env.workspaceId, agent: { kind: 'generic', command: 'synthetic' } })
    persistSession(env.stateRoot, env.workspaceId, { ...running, status: 'running' })
    await expect(resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: running.id, userDeclaration: declaration() }))
      .rejects.toThrow(/no Pre manifest/)
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('works when the lock was already legally unlocked: pid evidence recorded as unverifiable, not claimed as proof', async () => {
    const env = fresh('unlocked')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    rmSync(path.join(locksDir(env.stateRoot), `${env.workspaceId}.lock`)) // user ran unlock earlier
    const result = await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() })
    expect(result.session.status).toBe('abandoned')
    expect(result.pidEvidence).toBe('unverifiable-no-lock-record')
    expect(result.resolution.userDeclaration.childStopProven).toBe(false)
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('deterministic retry after a mid-disposition interrupt (status persisted, stale lock left behind)', async () => {
    const env = fresh('retry')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    const first = await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() })
    expect(first.lockReleased).toBe(true)
    // Simulate the interrupted window: abandoned persisted, stale resolve lock left behind.
    mkdirSync(locksDir(env.stateRoot), { recursive: true })
    writeFileSync(path.join(locksDir(env.stateRoot), `${env.workspaceId}.lock`), JSON.stringify({
      workspaceId: env.workspaceId, sessionId: session.id, pid: 99999999,
      hostname: os.hostname(), processStartedAt: 0, createdAt: new Date().toISOString(),
    }))
    const retry = await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() })
    expect(retry.alreadyAbandoned).toBe(true)
    expect(retry.lockReleased).toBe(true)
    const reread = listWorkspaceSessions({ workspaceRoot: env.ws, stateRoot: env.stateRoot })[0]
    expect(reread.status).toBe('abandoned')
    expect(reread.resolution?.kind).toBe('abandoned')
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('restore refuses rather than silently selecting an older session while the newest is abandoned', async () => {
    const env = fresh('guard')
    // Older review session (real flow).
    writeFileSync(path.join(env.ws, 'old.txt'), 'old-v1')
    const run = invoke(env.ws, env.stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('old.txt','old-v2')"])
    expect(run.status).toBe(0)
    // Newer session with its OWN real pre snapshot, forced to running, then abandoned.
    const newer = await createPreSnapshot({ workspaceRoot: env.ws, stateRoot: env.stateRoot, agent: { kind: 'generic', command: 'synthetic' } })
    persistSession(env.stateRoot, env.workspaceId, { ...newer.session, status: 'running' })
    await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: newer.session.id, userDeclaration: declaration() })
    expect(listWorkspaceSessions({ workspaceRoot: env.ws, stateRoot: env.stateRoot })[0].status).toBe('abandoned')
    const rollback = invoke(env.ws, env.stateRoot, ['rollback'])
    expect(rollback.status).toBe(2)
    expect(rollback.stderr + rollback.stdout).toContain('abandoned')
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('classification reports eligible with proved-dead evidence and honest consequences (CLI display contract)', async () => {
    const env = fresh('clishape')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    const classification = classifyAbandonment({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id })
    expect(classification.eligible).toBe(true)
    expect(classification.pidEvidence).toBe('proved-dead-local')
    expect(classification.consequences.join(' ')).toContain('not a commit')
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('a legit repeated abandon retry completes from the REAL persisted resolution (idempotent, no fabrication)', async () => {
    const env = fresh('retry-real')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    const first = await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() })
    expect(first.session.status).toBe('abandoned')
    const retry = await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() })
    expect(retry.alreadyAbandoned).toBe(true)
    const reread = listWorkspaceSessions({ workspaceRoot: env.ws, stateRoot: env.stateRoot })[0]
    expect(reread.status).toBe('abandoned')
    expect(reread.resolution?.kind).toBe('abandoned')
    expect(reread.resolution?.preManifestRef).toBe(reread.preManifestRef) // bound to the real Pre
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('an abandoned session whose resolution record is MISSING fails closed (no fabricated confirmation)', async () => {
    const env = fresh('retry-norec')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    const first = await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() })
    expect(first.session.status).toBe('abandoned')
    // simulate a torn/corrupt history: strip the resolution from the persisted record
    const sessionPathFile = path.join(env.stateRoot, 'workspaces', env.workspaceId, 'sessions', session.id + '.json')
    const raw = JSON.parse(readFileSync(sessionPathFile, 'utf8'))
    delete raw.resolution
    writeFileSync(sessionPathFile, JSON.stringify(raw, null, 2))
    await expect(resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() }))
      .rejects.toThrow(/resolution|abandoned record/i)
    // evidence and files untouched
    expect(listWorkspaceSessions({ workspaceRoot: env.ws, stateRoot: env.stateRoot })[0].status).toBe('abandoned')
    expect(readFileSync(path.join(env.ws, 'a.txt'), 'utf8')).toBe('x')
    rmSync(env.tmp, { recursive: true, force: true })
  })

  it('an abandoned session whose resolution Pre reference disagrees with the session Pre fails closed', async () => {
    const env = fresh('retry-badpre')
    const session = await crashedFixture(env, { 'a.txt': 'x' })
    await resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() })
    const sessionPathFile = path.join(env.stateRoot, 'workspaces', env.workspaceId, 'sessions', session.id + '.json')
    const raw = JSON.parse(readFileSync(sessionPathFile, 'utf8'))
    raw.resolution.preManifestRef = '00000000-0000-4000-8000-000000000000'
    writeFileSync(sessionPathFile, JSON.stringify(raw, null, 2))
    await expect(resolveSessionAbandon({ workspaceRoot: env.ws, stateRoot: env.stateRoot, sessionId: session.id, userDeclaration: declaration() }))
      .rejects.toThrow(/resolution|Pre|bound/i)
    rmSync(env.tmp, { recursive: true, force: true })
  })

})