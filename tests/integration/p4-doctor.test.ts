import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initializeWorkspace, loadManifest, locksDir, manifestPath, newSessionRecord, persistSession, sessionAdmission, unlockWorkspace, listWorkspaceSessions, createPreSnapshot, type Manifest } from '@agentcommit/core'
import { makeStateRoot, makeTempDir } from '../helpers.js'

const repo = path.resolve(import.meta.dirname, '../..')
const cli = path.join(repo, 'packages/cli/dist/index.js')
beforeAll(() => {
  for (const name of ['core', 'adapters', 'cli']) {
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/${name}/tsconfig.json`], { cwd: repo })
  }
}, 30_000)

function invoke(workspaceRoot: string, stateRoot: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: workspaceRoot, env: { ...process.env, AGENTCOMMIT_STATE_DIR: stateRoot }, encoding: 'utf8', timeout: 20_000,
  })
}

function doctor(workspaceRoot: string, stateRoot: string) {
  const result = invoke(workspaceRoot, stateRoot, ['doctor'])
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

function freshWorkspace() {
  const tmp = makeTempDir('agentcommit-p4-doctor-')
  const ws = path.join(tmp, 'ws')
  const stateRoot = makeStateRoot(tmp)
  mkdirSync(ws, { recursive: true })
  initializeWorkspace(ws)
  return { tmp, ws, stateRoot }
}

describe('P4 doctor read-only diagnosis', () => {
  it('a clean initialized workspace diagnoses as ok with no findings beyond platform notes', () => {
    const { ws, stateRoot } = freshWorkspace()
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('ok')
    expect(output.diagnosis.findings.every((f: { severity: string }) => f.severity === 'info')).toBe(true)
    expect(output.node).toBe(process.version)
    expect(output.admission.eligible).toBe(true)
  })

  it('a finished run awaiting review is attention with safe review entries; commit returns it to ok', () => {
    const { ws, stateRoot } = freshWorkspace()
    writeFileSync(path.join(ws, 'task.txt'), 'before')
    const run = invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('task.txt','after')"])
    expect(run.status, run.stderr).toBe(0)
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('attention')
    const review = output.diagnosis.findings.find((f: { code: string }) => f.code === 'session-review-pending')
    expect(review).toBeTruthy()
    expect(review.safeEntries.join(' ')).toContain('rollback')
    expect(invoke(ws, stateRoot, ['commit']).status).toBe(0)
    expect(doctor(ws, stateRoot).diagnosis.overall).toBe('ok')
  })

  it('an interrupted running session with a provably dead holder is blocked, names unlock as the safe entry, and the lock is releasable', () => {
    const { ws, stateRoot } = freshWorkspace()
    const workspaceId = JSON.parse(readFileSync(path.join(ws, '.agentcommit.json'), 'utf8')).workspaceId
    const session = newSessionRecord({ sessionId: randomUUID(), workspaceId, agent: { kind: 'generic', command: 'dead' } })
    persistSession(stateRoot, session.workspaceId, { ...session, status: 'running' })
    // A provably dead local holder: nonexistent pid + this host, written directly
    // because acquireLock always records a live caller pid.
    const DEAD_PID = 99999999
    mkdirSync(locksDir(stateRoot), { recursive: true })
    const lockPath = path.join(locksDir(stateRoot), `${session.workspaceId}.lock`)
    writeFileSync(lockPath, JSON.stringify({
      workspaceId: session.workspaceId, sessionId: session.id, pid: DEAD_PID,
      hostname: os.hostname(), processStartedAt: 0, createdAt: new Date().toISOString(), agentCommand: 'dead-pid-probe',
    }))
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('blocked')
    const finding = output.diagnosis.findings.find((f: { code: string }) => f.code === 'session-running-pid-dead')
    expect(finding).toBeTruthy()
    expect(finding.blockedActions.join(' ')).toContain('Do not fabricate a Post')
    expect(finding.safeEntries.join(' ')).toContain('unlock --session')
    // P4 review issue 05: the advice must state unlock's exact scope —
    // confirming the holder stopped is a PRECONDITION, unlock releases only
    // the lock, it does not end the Session or restore new-run admission, and
    // the crashed-run disposition is still a pending product decision that
    // cannot be bypassed by deleting records or faking a failed status. It
    // must not promise that a re-run will automatically succeed afterwards.
    expect(finding.humanConfirmation).toContain('before unlocking')
    expect(finding.humanConfirmation).toContain('precondition of unlock')
    expect(finding.humanConfirmation).toContain('releases only the lock')
    expect(finding.humanConfirmation).toContain('does not end the session')
    expect(finding.humanConfirmation).toContain('product decision')
    expect(finding.humanConfirmation).not.toMatch(/then re-run/i)
    expect(finding.humanConfirmation).not.toMatch(/will (?:be able to )?(?:re-?run|resume)/i)
    // The named safe entry actually works (the CLI wrapper adds interactive confirmation).
    unlockWorkspace({ workspaceRoot: ws, stateRoot, sessionId: session.id })
    expect(listWorkspaceSessions({ workspaceRoot: ws, stateRoot }).length).toBe(1)
    expect(readdirSync(path.join(stateRoot, 'locks')).length).toBe(0)
    // P4 review issue 05: unlock released ONLY the lock. The Session stays
    // running and sessionAdmission still refuses — no recovery shortcut.
    const after = listWorkspaceSessions({ workspaceRoot: ws, stateRoot })
    expect(after.length).toBe(1)
    expect(after[0].status).toBe('running')
    const admission = sessionAdmission(stateRoot, session.workspaceId)
    expect(admission.eligible).toBe(false)
    expect(admission.blockers.length).toBeGreaterThan(0)
    // A real new CLI run is still refused (exit 2) and writes nothing into the
    // workspace: no automatic re-run happens, let alone a promised success.
    const target = path.join(ws, 'issue05-synthetic-target.txt')
    const rerun = invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('issue05-synthetic-target.txt','written')"])
    expect(rerun.status).toBe(2)
    expect(existsSync(target)).toBe(false)
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  it('a corrupt session record fails closed as blocked instead of guessing ok', () => {
    const { ws, stateRoot } = freshWorkspace()
    const sessionsDir = path.join(stateRoot, 'workspaces', JSON.parse(readFileSync(path.join(ws, '.agentcommit.json'), 'utf8')).workspaceId, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(path.join(sessionsDir, 'not-json.json'), '{corrupt')
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('blocked')
    expect(output.admission.eligible).toBe(false)
    expect(output.diagnosis.findings.some((f: { code: string; severity: string }) => f.severity === 'blocked')).toBe(true)
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  it('a missing CAS blob referenced by the latest manifest is reported blocked', () => {
    const { ws, stateRoot } = freshWorkspace()
    writeFileSync(path.join(ws, 'blob.txt'), 'payload')
    const run = invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('blob.txt','changed')"])
    expect(run.status, run.stderr).toBe(0)
    const sessions = listWorkspaceSessions({ workspaceRoot: ws, stateRoot })
    const manifest = loadManifest(stateRoot, sessions[0].workspaceId, sessions[0].preManifestRef!)
    const hash = Object.values(manifest.files as Record<string, { hash: string }>)[0].hash
    rmSync(path.join(stateRoot, 'blobs', 'sha256', hash.slice(0, 2), hash.slice(2)))
    const output = doctor(ws, stateRoot)
    const finding = output.diagnosis.findings.find((f: { code: string }) => f.code === 'cas-blob-missing')
    expect(finding).toBeTruthy()
    expect(finding.severity).toBe('blocked')
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  it('--report writes a whitelisted, path-anonymized local JSON file and no absolute path leaks', () => {
    const { ws, stateRoot, tmp } = freshWorkspace()
    writeFileSync(path.join(ws, 'r.txt'), 'x')
    expect(invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('r.txt','y')"]).status).toBe(0)
    const reportPath = path.join(tmp, 'doctor-report.json')
    const result = invoke(ws, stateRoot, ['doctor', '--report', reportPath])
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(reportPath)).toBe(true)
    const raw = readFileSync(reportPath, 'utf8')
    const report = JSON.parse(raw)
    expect(report.reportSchema).toBe('agentcommit.doctor-report.v1')
    expect(report.paths.workspace).toBe('workspace-1')
    // Neither the absolute workspace path, the state root, nor the OS user name may appear.
    expect(raw.includes(ws)).toBe(false)
    expect(raw.includes(stateRoot)).toBe(false)
    expect(raw.includes(process.env.USERNAME)).toBe(false)
    expect(JSON.stringify(report).toLowerCase().includes('hostname":') === false || report.privacy).toBeTruthy()
  })
})

/**
 * P4 review issue 03: doctor claimed Manifest↔Session binding was verified but
 * only ran loadManifest's structural check — a structurally valid manifest
 * whose sessionId/workspaceId/manifest.id drifted from the Session reference
 * (or whose Post policy drifted from the frozen Pre policy, same cap) was
 * diagnosed healthy. Doctor must instead obtain Pre/Post through core's
 * inspectSession (validateManifestBinding + frozen-policy validation) BEFORE
 * any CAS health conclusion or protection summary, and fail closed as a
 * stable blocked manifest-anomaly finding.
 */
describe('P4 review issue 03: doctor verifies Manifest↔Session binding via inspectSession', () => {
  function runReviewSession(ws: string, stateRoot: string) {
    writeFileSync(path.join(ws, 'issue03.txt'), 'before')
    const run = invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('issue03.txt','after')"])
    expect(run.status, run.stderr).toBe(0)
    const sessions = listWorkspaceSessions({ workspaceRoot: ws, stateRoot })
    expect(sessions.length).toBeGreaterThan(0)
    return sessions[0]
  }

  /** Rewrite a persisted manifest with a mutation applied to its parsed JSON (shape stays schema-valid). */
  function tamperManifest(
    stateRoot: string, workspaceId: string, ref: string,
    mutate: (manifest: Record<string, unknown>) => void,
  ) {
    const file = manifestPath(stateRoot, workspaceId, ref)
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    mutate(manifest)
    writeFileSync(file, JSON.stringify(manifest, null, 2))
  }

  interface TamperCase {
    name: string
    /** Which persisted manifest to rewrite; defaults to pre. */
    target: 'pre' | 'post'
    mutate: (manifest: Record<string, unknown>) => void
  }

  const OTHER_SAFE_ID = '0123456789abcdef0123456789abcdef'

  const cases: TamperCase[] = [
    {
      name: 'pre manifest sessionId does not match the session',
      target: 'pre',
      mutate: (m) => { m.sessionId = OTHER_SAFE_ID },
    },
    {
      name: 'pre manifest workspaceId does not match the workspace',
      target: 'pre',
      mutate: (m) => { m.workspaceId = OTHER_SAFE_ID },
    },
    {
      name: 'pre manifest.id does not match the session preManifestRef',
      target: 'pre',
      mutate: (m) => { m.id = OTHER_SAFE_ID },
    },
    {
      name: 'post manifest sessionId does not match the session',
      target: 'post',
      mutate: (m) => { m.sessionId = OTHER_SAFE_ID },
    },
    {
      name: 'post manifest.id does not match the session postManifestRef',
      target: 'post',
      mutate: (m) => { m.id = OTHER_SAFE_ID },
    },
    {
      name: 'post policy drifted from the frozen pre policy (same maxFileSizeBytes cap)',
      target: 'post',
      mutate: (m) => {
        const policy = m.protectionPolicy as Record<string, unknown>
        policy.ignoreRules = [...(policy.ignoreRules as string[]), 'late-added-rule']
      },
    },
  ]

  for (const testCase of cases) {
    it(`a schema-valid ${testCase.name} is blocked manifest-anomaly with no CAS health conclusion`, () => {
      const { ws, stateRoot } = freshWorkspace()
      const session = runReviewSession(ws, stateRoot)
      const ref = testCase.target === 'pre' ? session.preManifestRef! : session.postManifestRef!
      tamperManifest(stateRoot, session.workspaceId, ref, testCase.mutate)
      const output = doctor(ws, stateRoot)
      expect(output.diagnosis.overall).toBe('blocked')
      const finding = output.diagnosis.findings.find((f: { code: string }) => f.code === 'manifest-anomaly')
      expect(finding, `manifest-anomaly finding missing for: ${testCase.name}`).toBeTruthy()
      expect(finding.severity).toBe('blocked')
      // Doctor must not emit any CAS/manifest health conclusion derived from the unbound manifest.
      expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-blob-missing')).toBe(false)
      rmSync(ws, { recursive: true, force: true })
      rmSync(stateRoot, { recursive: true, force: true })
    })
  }

  it('a matching, untampered run still diagnoses normally (review pending, no manifest-anomaly)', () => {
    const { ws, stateRoot } = freshWorkspace()
    runReviewSession(ws, stateRoot)
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('attention')
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'manifest-anomaly')).toBe(false)
    expect(output.diagnosis.findings.find((f: { code: string }) => f.code === 'session-review-pending')).toBeTruthy()
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  it('a workspace with no session and a session with no manifest keep the existing normal behavior', () => {
    const { ws, stateRoot } = freshWorkspace()
    expect(doctor(ws, stateRoot).diagnosis.overall).toBe('ok')
    const workspaceId = JSON.parse(readFileSync(path.join(ws, '.agentcommit.json'), 'utf8')).workspaceId
    const session = newSessionRecord({ sessionId: randomUUID(), workspaceId, agent: { kind: 'generic', command: 'none' } })
    persistSession(stateRoot, session.workspaceId, { ...session, status: 'ready' })
    const output = doctor(ws, stateRoot)
    // A legally manifest-less session is unfinished setup (attention), never a manifest-anomaly.
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'manifest-anomaly')).toBe(false)
    expect(output.diagnosis.overall).toBe('attention')
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })
})

/**
 * P4 review issue 04: doctor's CAS check stopped after 5000 references and
 * silently skipped hashes that were not 64-char strings, so missing blobs
 * beyond the cap — and invalid hashes on protected ordinary files — were
 * diagnosed as healthy. Doctor now checks EVERY required protected
 * ordinary-file CAS reference (no cap) and fails closed (blocked
 * cas-hash-invalid) when a required hash does not meet the CAS SHA-256 hex
 * contract. Recorded links and unprotected/ignored entries never require a
 * blob and must not be false-positived. Only EXISTENCE is checked — the
 * finding text never claims content hashes were re-verified.
 */
describe('P4 review issue 04: doctor covers all required CAS references and fails closed on invalid hashes', () => {
  function runReviewSession(ws: string, stateRoot: string) {
    writeFileSync(path.join(ws, 'issue04.txt'), 'before')
    const run = invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('issue04.txt','after')"])
    expect(run.status, run.stderr).toBe(0)
    const sessions = listWorkspaceSessions({ workspaceRoot: ws, stateRoot })
    expect(sessions.length).toBeGreaterThan(0)
    return sessions[0]
  }

  /**
   * Controlled corruption surface: the persisted manifest is schema-valid JSON,
   * and these tests deliberately rewrite fields into contract-violating values.
   * Every field is `unknown` at the mutation site, so no `any` or eslint-disable
   * is needed to express broken inputs.
   */
  interface TamperedRecord {
    path?: unknown
    type?: unknown
    hash?: unknown
    size?: unknown
    protected?: unknown
    symlinkTarget?: unknown
    reasonUnprotected?: unknown
  }
  type TamperedManifest = Omit<Manifest, 'files'> & { files: TamperedRecord[] }

  function rewriteManifest(
    stateRoot: string, workspaceId: string, ref: string,
    mutate: (manifest: TamperedManifest) => void,
  ) {
    const file = manifestPath(stateRoot, workspaceId, ref)
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as unknown as TamperedManifest
    mutate(manifest)
    writeFileSync(file, JSON.stringify(manifest, null, 2))
  }

  it('a manifest with more than 5000 required references and the LAST one missing is blocked with real coverage counts', () => {
    const { ws, stateRoot, tmp } = freshWorkspace()
    const session = runReviewSession(ws, stateRoot)
    // Controlled manifest construction with minimal fixture IO: coverage is
    // per reference, not per blob, so ONE legitimate CAS blob referenced by
    // 5000+ distinct paths proves the loop runs past the old 5000 cap; a final
    // record referencing a never-stored (but format-valid) hash proves the
    // tail-end reference is still checked. inspectSession accepts this: the
    // binding stays intact and only the pre manifest is extended.
    const COUNT = 5005
    rewriteManifest(stateRoot, session.workspaceId, session.preManifestRef!, (m) => {
      const sharedContent = 'issue04-shared-blob'
      const sharedHash = createHash('sha256').update(sharedContent).digest('hex')
      const blob = path.join(stateRoot, 'blobs', 'sha256', sharedHash.slice(0, 2), sharedHash.slice(2))
      mkdirSync(path.dirname(blob), { recursive: true })
      writeFileSync(blob, sharedContent)
      const ghostHash = createHash('sha256').update('issue04-never-stored').digest('hex')
      for (let i = 0; i < COUNT - 1; i++) {
        m.files.push({ path: `issue04-synth/file-${i}.txt`, type: 'file', hash: sharedHash, size: sharedContent.length, protected: true })
      }
      m.files.push({ path: 'issue04-synth/file-last.txt', type: 'file', hash: ghostHash, size: 0, protected: true })
    })
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('blocked')
    const finding = output.diagnosis.findings.find((f: { code: string }) => f.code === 'cas-blob-missing')
    expect(finding, 'cas-blob-missing must surface beyond the old 5000 cap').toBeTruthy()
    expect(finding.severity).toBe('blocked')
    // Real coverage: every required reference in the pre manifest was counted
    // (the original protected file + 5005 synthetic ones) and exactly the last
    // synthetic blob is reported missing.
    expect(finding.counters.checked).toBeGreaterThan(5000)
    expect(finding.counters.missing).toBe(1)
    expect(finding.what).toContain('existence check')
    // Shared report: the finding passes the whitelist with its counters and
    // leaks no absolute path.
    const reportPath = path.join(tmp, 'issue04-report.json')
    expect(invoke(ws, stateRoot, ['doctor', '--report', reportPath]).status, 'doctor --report runs').toBe(0)
    const raw = readFileSync(reportPath, 'utf8')
    expect(raw.includes(stateRoot)).toBe(false)
    const report = JSON.parse(raw)
    const shared = report.diagnosis.findings.find((f: { code: string }) => f.code === 'cas-blob-missing')
    expect(shared).toBeTruthy()
    expect(shared.counters.checked).toBeGreaterThan(5000)
    expect(shared.counters.missing).toBe(1)
    rmSync(ws, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  })

  interface BadHashCase { name: string; hash: unknown }

  const badHashCases: BadHashCase[] = [
    { name: '64 non-hex characters (would pass the old length-only check)', hash: 'X'.repeat(64) },
    { name: 'uppercase hex is not the CAS address contract', hash: 'A'.repeat(64) },
    { name: 'wrong length', hash: 'abc123' },
    { name: 'missing hash on a protected ordinary file', hash: undefined },
    { name: 'non-string hash', hash: 42 },
  ]

  for (const testCase of badHashCases) {
    it(`a protected ordinary file with ${testCase.name} is blocked cas-hash-invalid, never silently passed`, () => {
      const { ws, stateRoot } = freshWorkspace()
      const session = runReviewSession(ws, stateRoot)
      rewriteManifest(stateRoot, session.workspaceId, session.preManifestRef!, (m) => {
        const record = m.files.find((r: TamperedRecord) => r.path === 'issue04.txt')
        expect(record, 'the run must have protected issue04.txt').toBeTruthy()
        record!.protected = true
        record!.type = 'file'
        if (testCase.hash === undefined) delete record!.hash
        else record!.hash = testCase.hash
      })
      const output = doctor(ws, stateRoot)
      expect(output.diagnosis.overall).toBe('blocked')
      const finding = output.diagnosis.findings.find((f: { code: string }) => f.code === 'cas-hash-invalid')
      expect(finding, `cas-hash-invalid missing for: ${testCase.name}`).toBeTruthy()
      expect(finding.severity).toBe('blocked')
      expect(finding.counters.invalid).toBe(1)
      expect(finding.counters.checked).toBeGreaterThan(0)
      rmSync(ws, { recursive: true, force: true })
      rmSync(stateRoot, { recursive: true, force: true })
    })
  }

  it('recorded links, unprotected entries, and empty-path unprotected records never trigger CAS findings', () => {
    const { ws, stateRoot } = freshWorkspace()
    const session = runReviewSession(ws, stateRoot)
    rewriteManifest(stateRoot, session.workspaceId, session.preManifestRef!, (m) => {
      // Protected link: restorable from its recorded target — no blob required.
      // Only symlink/junction are known-target link records here; a protected
      // 'reparse' is NOT a known safe link and gets its own blocked test below.
      m.files.push({ path: 'issue04-link', type: 'symlink', size: 0, protected: true, symlinkTarget: 'target' })
      m.files.push({ path: 'issue04-junction', type: 'junction', size: 0, protected: true, symlinkTarget: 'target' })
      // Unprotected ordinary file without a hash: never claimed restorable.
      m.files.push({ path: 'issue04-unprotected', type: 'file', size: 3, protected: false, reasonUnprotected: 'file-too-large' })
      // Unprotected record with an empty path: skipped, not a false positive.
      m.files.push({ path: '', type: 'file', size: 0, protected: false })
    })
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-blob-missing')).toBe(false)
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-hash-invalid')).toBe(false)
    // Still the normal review-pending diagnosis: legal necessary blobs stay healthy.
    expect(output.diagnosis.overall).toBe('attention')
    expect(output.diagnosis.findings.find((f: { code: string }) => f.code === 'session-review-pending')).toBeTruthy()
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  // Static probe replay (issue-04-type-probes.json: unknownTypeBlocked was
  // false): a protected record whose type is not a known restorable kind was
  // treated as a healthy ordinary file whenever it carried a format-valid hash
  // pointing at an existing blob. The fail-closed contract has TWO layers, and
  // neither may be weakened to reach the other:
  //
  // Layer 1 — a record type outside core's own whitelist (validateRestorePlanInputs)
  // is already rejected by inspectSession on a pre+post session: doctor must
  // surface that as manifest-anomaly blocked and must NOT bypass the binding
  // validation just to reach its CAS branch.
  it('a protected record type outside core whitelist is blocked manifest-anomaly by inspectSession, with no CAS health conclusion', () => {
    const { ws, stateRoot } = freshWorkspace()
    const session = runReviewSession(ws, stateRoot)
    rewriteManifest(stateRoot, session.workspaceId, session.preManifestRef!, (m) => {
      const goodHash = m.files.find((r: TamperedRecord) => r.path === 'issue04.txt')?.hash
      expect(goodHash, 'the run must have protected issue04.txt').toBeTruthy()
      // Type outside core's record whitelist: inspectSession's restore-input
      // validation rejects the manifest before doctor's CAS layer may speak.
      m.files.push({ path: 'issue04-unknown-type', type: 'unknown-protected-type', hash: goodHash, size: 0, protected: true })
    })
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('blocked')
    const finding = output.diagnosis.findings.find((f: { code: string }) => f.code === 'manifest-anomaly')
    expect(finding, 'inspectSession must reject the structurally bad record as manifest-anomaly').toBeTruthy()
    expect(finding.severity).toBe('blocked')
    // No CAS branch conclusion of any kind is derived from the unbound manifest.
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-record-type-unknown')).toBe(false)
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-blob-missing')).toBe(false)
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-hash-invalid')).toBe(false)
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  // Layer 2 — doctor's own CAS type branch is exercised on a LEGAL pre-only
  // Session (createPreSnapshot: real scan, real binding, no Post yet, so
  // inspectSession runs loadManifest + binding but not the pre/post restore
  // validation). Types core accepts ('unsupported', 'reparse') that doctor
  // cannot treat as a known-target link or an ordinary file must be blocked
  // cas-record-type-unknown there — a valid existing hash never buys health.
  it('protected unsupported/reparse records on a legal pre-only session are blocked cas-record-type-unknown even with a valid existing hash', async () => {
    const { ws, stateRoot } = freshWorkspace()
    writeFileSync(path.join(ws, 'issue04.txt'), 'before')
    const snapshot = await createPreSnapshot({ workspaceRoot: ws, stateRoot, agent: { kind: 'generic', command: 'issue04-pre-only' } })
    expect(snapshot.session.status).toBe('snapshot')
    rewriteManifest(stateRoot, snapshot.session.workspaceId, snapshot.session.preManifestRef!, (m) => {
      // Reuse the real, existing blob hash of issue04.txt: the records below
      // must be blocked on their TYPE, not on a hash or blob problem.
      const goodHash = m.files.find((r: TamperedRecord) => r.path === 'issue04.txt')?.hash
      expect(goodHash, 'the snapshot must have protected issue04.txt').toBeTruthy()
      m.files.push({ path: 'issue04-unsupported-type', type: 'unsupported', hash: goodHash, size: 0, protected: true })
      m.files.push({ path: 'issue04-reparse', type: 'reparse', size: 0, protected: true, symlinkTarget: 'target' })
    })
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('blocked')
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'manifest-anomaly')).toBe(false)
    const finding = output.diagnosis.findings.find((f: { code: string }) => f.code === 'cas-record-type-unknown')
    expect(finding, 'cas-record-type-unknown must surface for protected records that are neither known links nor ordinary files').toBeTruthy()
    expect(finding.severity).toBe('blocked')
    expect(finding.counters.unknownTypeRecords).toBe(2)
    expect(finding.counters.checked).toBeGreaterThan(0)
    // The valid hash never resolved to a missing/invalid-hash conclusion, and
    // the recorded symlink/junction links stay exempt (previous test).
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-blob-missing')).toBe(false)
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-hash-invalid')).toBe(false)
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  // Static probe replay (issue-04-type-probes.json: blobDirectoryBlocked was
  // false): a required blob path occupied by a synthetic directory satisfied
  // existsSync, so doctor called it healthy. The blob check must not follow
  // links and must only accept a confirmed regular file: ENOENT is missing,
  // anything else is stably blocked.
  it('a required blob path occupied by a directory (existsSync true) is blocked, not healthy', () => {
    const { ws, stateRoot } = freshWorkspace()
    const session = runReviewSession(ws, stateRoot)
    const manifest = loadManifest(stateRoot, session.workspaceId, session.preManifestRef!)
    const record = manifest.files.find((r) => r.path === 'issue04.txt')
    expect(record?.hash, 'the run must have protected issue04.txt').toBeTruthy()
    const blob = path.join(stateRoot, 'blobs', 'sha256', record!.hash!.slice(0, 2), record!.hash!.slice(2))
    rmSync(blob)
    mkdirSync(blob, { recursive: true }) // a directory squatting on the CAS address
    const output = doctor(ws, stateRoot)
    expect(output.diagnosis.overall).toBe('blocked')
    const finding = output.diagnosis.findings.find((f: { code: string }) => f.code === 'cas-blob-not-regular')
    expect(finding, 'cas-blob-not-regular must surface for a non-regular blob entry').toBeTruthy()
    expect(finding.severity).toBe('blocked')
    expect(finding.counters.irregular).toBe(1)
    expect(finding.counters.checked).toBeGreaterThan(0)
    // Not misclassified as missing (it "exists") and never claimed content-verified.
    expect(output.diagnosis.findings.some((f: { code: string }) => f.code === 'cas-blob-missing')).toBe(false)
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })
})

/** SHA-256 of every regular file under root, keyed by relative path (state-immutability oracle). */
function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) out.set(path.relative(root, p), createHash('sha256').update(readFileSync(p)).digest('hex'))
    }
  }
  walk(root)
  return out
}

describe('P4 review issue 01: --report creates exclusively and never overwrites', () => {
  it('an existing plain file is never truncated or replaced; the command fails instead', () => {
    const { ws, stateRoot, tmp } = freshWorkspace()
    const victim = path.join(tmp, 'existing.txt')
    writeFileSync(victim, 'original-bytes')
    const result = invoke(ws, stateRoot, ['doctor', '--report', victim])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('refused')
    expect(readFileSync(victim, 'utf8')).toBe('original-bytes')
    rmSync(ws, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  })

  it('existing state Session/Manifest files are untouched, and new paths inside the state root are refused', () => {
    const { ws, stateRoot } = freshWorkspace()
    writeFileSync(path.join(ws, 's.txt'), 'a')
    expect(invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('s.txt','b')"]).status).toBe(0)
    const before = hashTree(stateRoot)
    expect(before.size).toBeGreaterThan(0)
    // 1) Target an existing Session file directly.
    const sessionsDir = path.join(stateRoot, 'workspaces', JSON.parse(readFileSync(path.join(ws, '.agentcommit.json'), 'utf8')).workspaceId, 'sessions')
    const existingSessionFile = path.join(sessionsDir, readdirSync(sessionsDir)[0])
    // 2) Target a not-yet-existing path inside the state root (creation there must also be refused).
    const newInState = path.join(stateRoot, 'doctor-report-new.json')
    for (const target of [existingSessionFile, newInState]) {
      const result = invoke(ws, stateRoot, ['doctor', '--report', target])
      expect(result.status, `${target}: ${result.stderr}`).not.toBe(0)
      expect(result.stderr).toContain('refused')
    }
    expect(existsSync(newInState)).toBe(false)
    expect(hashTree(stateRoot)).toEqual(before)
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })

  it('a parent junction/symlink that physically aliases the state root is refused', () => {
    const { ws, stateRoot, tmp } = freshWorkspace()
    const link = path.join(tmp, 'state-alias')
    // Junction on Windows (unprivileged), directory symlink on POSIX.
    symlinkSync(stateRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
    const viaAlias = path.join(link, 'report-should-not-exist.json')
    const result = invoke(ws, stateRoot, ['doctor', '--report', viaAlias])
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toContain('refused')
    expect(existsSync(viaAlias)).toBe(false)
    expect(existsSync(path.join(stateRoot, 'report-should-not-exist.json'))).toBe(false)
    rmSync(ws, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a fresh report path succeeds, and a second run with the same name is refused with content unchanged', () => {
    const { ws, stateRoot, tmp } = freshWorkspace()
    const reportPath = path.join(tmp, 'fresh-report.json')
    const first = invoke(ws, stateRoot, ['doctor', '--report', reportPath])
    expect(first.status, first.stderr).toBe(0)
    const bytes = readFileSync(reportPath)
    expect(JSON.parse(bytes.toString('utf8')).reportSchema).toBe('agentcommit.doctor-report.v1')
    const second = invoke(ws, stateRoot, ['doctor', '--report', reportPath])
    expect(second.status).not.toBe(0)
    expect(second.stderr).toContain('refused')
    expect(readFileSync(reportPath).equals(bytes)).toBe(true)
    rmSync(ws, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a report path inside the workspace .git directory is refused', () => {
    const { ws, stateRoot } = freshWorkspace()
    const gitDir = path.join(ws, '.git')
    mkdirSync(gitDir, { recursive: true })
    const result = invoke(ws, stateRoot, ['doctor', '--report', path.join(gitDir, 'report.json')])
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toContain('refused')
    expect(existsSync(path.join(gitDir, 'report.json'))).toBe(false)
    rmSync(ws, { recursive: true, force: true })
    rmSync(stateRoot, { recursive: true, force: true })
  })
})

/**
 * P4 review issue 02: the shared --report must not leak raw session ids,
 * absolute path prefixes, hostnames, or business identifiers carried by
 * diagnosis free text, error messages, and admission blocker strings.
 */
describe('P4 review issue 02: shared report never leaks diagnosis free text', () => {
  function readReport(raw: string) {
    const report = JSON.parse(raw)
    expect(report.reportSchema).toBe('agentcommit.doctor-report.v1')
    return report
  }

  it('a normal review-pending report contains no real session id; the finding keeps its code and anonymous reference', () => {
    const { ws, stateRoot, tmp } = freshWorkspace()
    writeFileSync(path.join(ws, 'review.txt'), 'before')
    expect(invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('review.txt','after')"]).status).toBe(0)
    const sessions = listWorkspaceSessions({ workspaceRoot: ws, stateRoot })
    expect(sessions.length).toBeGreaterThan(0)
    const reportPath = path.join(tmp, 'issue02-review-report.json')
    expect(invoke(ws, stateRoot, ['doctor', '--report', reportPath]).status).toBe(0)
    const raw = readFileSync(reportPath, 'utf8')
    for (const session of sessions) {
      expect(raw.includes(session.id), `raw session id leaked: ${session.id}`).toBe(false)
    }
    const report = readReport(raw)
    const finding = report.diagnosis.findings.find((f: { code: string }) => f.code === 'session-review-pending')
    expect(finding).toBeTruthy()
    expect(finding.severity).toBe('attention')
    expect(finding.session).toBe('session-0001')
    expect(report.diagnosis.overall).toBe('attention')
    rmSync(ws, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a corrupt-manifest report keeps the blocked manifest-anomaly classification but leaks no root/state/user/hostname/id or raw error text', () => {
    const { ws, stateRoot, tmp } = freshWorkspace()
    writeFileSync(path.join(ws, 'm.txt'), 'before')
    expect(invoke(ws, stateRoot, ['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('m.txt','after')"]).status).toBe(0)
    const sessions = listWorkspaceSessions({ workspaceRoot: ws, stateRoot })
    // Corrupt the persisted pre manifest so loadManifest throws with an error
    // message that locally carries the absolute manifest path.
    writeFileSync(manifestPath(stateRoot, sessions[0].workspaceId, sessions[0].preManifestRef!), '{corrupt-manifest-bytes')
    const reportPath = path.join(tmp, 'issue02-corrupt-manifest-report.json')
    expect(invoke(ws, stateRoot, ['doctor', '--report', reportPath]).status).toBe(0)
    const raw = readFileSync(reportPath, 'utf8')
    expect(raw.includes(stateRoot)).toBe(false)
    expect(raw.includes(ws)).toBe(false)
    expect(raw.includes(process.env.USERNAME)).toBe(false)
    expect(raw.includes(os.hostname())).toBe(false)
    expect(raw.includes('corrupt-manifest-bytes')).toBe(false)
    for (const session of sessions) {
      expect(raw.includes(session.id)).toBe(false)
    }
    const report = readReport(raw)
    const finding = report.diagnosis.findings.find((f: { code: string }) => f.code === 'manifest-anomaly')
    expect(finding).toBeTruthy()
    expect(finding.severity).toBe('blocked')
    expect(report.diagnosis.overall).toBe('blocked')
    rmSync(ws, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  })

  it('a business-named corrupt session record is classified blocked without the business identifier or record name in the report', () => {
    const { ws, stateRoot, tmp } = freshWorkspace()
    const sessionsDir = path.join(stateRoot, 'workspaces', JSON.parse(readFileSync(path.join(ws, '.agentcommit.json'), 'utf8')).workspaceId, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    // A record whose file name itself carries a business identifier; the local
    // diagnosis and admission blockers name it, the shared report must not.
    writeFileSync(path.join(sessionsDir, 'ACME-SECRET-ROADMAP.json'), '{corrupt')
    const reportPath = path.join(tmp, 'issue02-business-name-report.json')
    const result = invoke(ws, stateRoot, ['doctor', '--report', reportPath])
    expect(result.status, result.stderr).toBe(0)
    const raw = readFileSync(reportPath, 'utf8')
    expect(raw.includes('ACME')).toBe(false)
    expect(raw.includes('SECRET')).toBe(false)
    expect(raw.includes('ROADMAP')).toBe(false)
    const report = readReport(raw)
    expect(report.admission.blockerCount).toBeGreaterThan(0)
    expect(report.diagnosis.overall).toBe('blocked')
    expect(report.diagnosis.findings.some((f: { severity: string }) => f.severity === 'blocked')).toBe(true)
    rmSync(ws, { recursive: true, force: true })
    rmSync(tmp, { recursive: true, force: true })
  })

  it('unit: buildReport drops free text, raw ids, unknown codes, and non-finite counters while keeping codes, severities, counters, and anonymous references', async () => {
    // Dynamic import: runs after the beforeAll build so '@agentcommit/core'
    // resolves against the freshly built dist.
    const { buildReport } = await import('../../packages/cli/src/doctor.ts')
    const secret = 'ACME-SECRET-ROADMAP'
    const rawId = randomUUID()
    const result = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      workspaceRoot: '/Users/leaker/ws',
      stateRoot: '/Users/leaker/state',
      lock: { state: 'absent' as const },
      admission: { eligible: false, blockers: [`session file ${secret}.json is corrupt under /Users/leaker/state`] },
      sessions: [{ id: rawId, status: 'review', startedAt: '2026-09-09T00:00:00.000Z' }],
      diagnosis: {
        overall: 'attention' as const,
        findings: [
          { code: 'session-review-pending', severity: 'attention' as const, what: `Session ${rawId} (${secret}) waits for review`, impact: secret, blockedActions: [], safeEntries: [], humanConfirmation: '', sessionId: rawId },
          { code: 'manifest-anomaly', severity: 'blocked' as const, what: `manifest load failed: /Users/leaker/state/manifests/${secret}.json`, impact: '', blockedActions: [], safeEntries: [], humanConfirmation: '' },
          { code: 'brand-new-unknown-code', severity: 'attention' as const, what: secret, impact: secret, blockedActions: [secret], safeEntries: [secret], humanConfirmation: secret },
          { code: 'cas-blob-missing', severity: 'blocked' as const, what: `${secret} blobs gone`, impact: '', blockedActions: [], safeEntries: [], humanConfirmation: '', counters: { missing: 3, checked: 10, poison: Number.NaN } },
          { code: 'restore-incomplete', severity: 'weird' as never, what: '', impact: '', blockedActions: [], safeEntries: [], humanConfirmation: '', sessionId: rawId, counters: { attempts: 2, receipts: 1 } },
        ],
      },
      boundaries: ['fixed boundary text'],
    }
    const report = buildReport(result as never) as Record<string, unknown>
    const raw = JSON.stringify(report)
    expect(raw.includes(secret)).toBe(false)
    expect(raw.includes(rawId)).toBe(false)
    expect(raw.includes('leaker')).toBe(false)
    const diagnosis = report.diagnosis as { findings: Array<Record<string, unknown>> }
    const findings = diagnosis.findings
    const review = findings.find(f => f.code === 'session-review-pending')
    expect(review?.severity).toBe('attention')
    expect(review?.session).toBe('session-0001')
    expect(review?.what).toBe('A session finished and waits for review.')
    expect(findings.find(f => f.code === 'manifest-anomaly')?.severity).toBe('blocked')
    const unknown = findings.find(f => f.code === 'unknown-finding')
    expect(unknown).toBeTruthy()
    expect(JSON.stringify(unknown).includes(secret)).toBe(false)
    const cas = findings.find(f => f.code === 'cas-blob-missing')
    expect(cas?.counters).toEqual({ missing: 3, checked: 10 })
    // Invalid severity fails closed to blocked.
    expect(findings.find(f => f.code === 'restore-incomplete')?.severity).toBe('blocked')
  })
})
