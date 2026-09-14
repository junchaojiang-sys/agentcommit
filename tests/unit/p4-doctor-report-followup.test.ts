import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir } from '../helpers.js'
import { writeDoctorReportExclusively, buildReport, type DoctorResult } from '../../packages/cli/src/doctor.js'

/**
 * P4 review issue 01 follow-up (Windows case-insensitivity + missing protected paths).
 *
 * On Windows, realpathSync does not normalize the input's letter case to the
 * on-disk form, so strict string comparison let a case-variant of a protected
 * path through. And a declared protected path that does not exist yet was
 * skipped entirely, allowing a report file to be created exactly where a
 * protected directory (e.g. a future state root) belongs.
 */
describe('P4 issue 01 follow-up: protected-path comparison semantics', () => {
  // Windows is case-insensitive (typical volumes): the case-variant target is
  // the same physical location and must be refused. POSIX stays case-sensitive.
  it.skipIf(process.platform !== 'win32')(
    'a Windows case-variant of an existing protected directory is refused',
    () => {
      const tmp = makeTempDir('agentcommit-p4-followup-case-')
      const state = path.join(tmp, 'MiXeD-State')
      mkdirSync(state, { recursive: true })
      const target = path.join(state.toUpperCase(), 'probe.json')
      expect(() =>
        writeDoctorReportExclusively(target, '{}\n', [{ label: 'state root', p: state }]),
      ).toThrow(/refused/)
      expect(existsSync(path.join(state, 'probe.json'))).toBe(false)
      rmSync(tmp, { recursive: true, force: true })
    },
  )

  it('a declared protected path that does not exist yet is not skipped', () => {
    const tmp = makeTempDir('agentcommit-p4-followup-missing-')
    const futureState = path.join(tmp, 'future-state') // declared, not yet created
    // A report file at exactly the protected location would block the future
    // directory itself; a report inside it would create that directory. Both refused.
    expect(() =>
      writeDoctorReportExclusively(futureState, '{}\n', [{ label: 'state root', p: futureState }]),
    ).toThrow(/refused/)
    expect(() =>
      writeDoctorReportExclusively(path.join(futureState, 'report.json'), '{}\n', [
        { label: 'state root', p: futureState },
      ]),
    ).toThrow(/refused/)
    expect(existsSync(futureState)).toBe(false)
    // A sibling new path outside every protected location still succeeds ('wx').
    const ok = path.join(tmp, 'fresh-report.json')
    expect(() =>
      writeDoctorReportExclusively(ok, '{}\n', [{ label: 'state root', p: futureState }]),
    ).not.toThrow()
    expect(existsSync(ok)).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })

  // Alias replay: the protected state root is reached through an alias
  // directory (junction on Windows, dir symlink on POSIX) pointing at the
  // temp root. The state root under the real path does not exist yet, so the
  // report target alias/future-state resolves to root/future-state only after
  // link resolution — it must still be refused without creating the directory.
  it('an alias path resolving into a not-yet-existing protected state root is refused', () => {
    const tmp = makeTempDir('agentcommit-p4-followup-alias-')
    const alias = path.join(tmp, 'alias')
    symlinkSync(tmp, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const stateRoot = path.join(tmp, 'future-state') // declared, not yet created
    const target = path.join(alias, 'future-state')
    expect(() =>
      writeDoctorReportExclusively(target, '{}\n', [{ label: 'state root', p: stateRoot }]),
    ).toThrow(/refused/)
    expect(existsSync(stateRoot)).toBe(false)
    rmSync(tmp, { recursive: true, force: true })
  })
})

/**
 * P4 review issue 04 follow-up: the two new doctor finding codes
 * (cas-record-type-unknown, cas-blob-not-regular) must pass the issue-02
 * shared-report whitelist like every known code — stable code, validated
 * severity, fixed per-code text, numeric counters, anonymous session
 * reference — while the leaky local free text never reaches the report.
 */
describe('P4 issue 04 follow-up: new CAS findings pass the issue-02 whitelist', () => {
  it('keeps code, severity, and counters with fixed text and leaks no free text or raw ids', () => {
    const secret = 'ACME-SECRET-BLOBPATH'
    const rawId = randomUUID()
    const result: DoctorResult = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      workspaceRoot: '/Users/leaker/ws',
      stateRoot: '/Users/leaker/state',
      lock: { state: 'absent' },
      admission: { eligible: false, blockers: [secret] },
      sessions: [{ id: rawId, status: 'review', startedAt: '2026-09-09T00:00:00.000Z' }],
      diagnosis: {
        overall: 'blocked',
        findings: [
          {
            code: 'cas-record-type-unknown', severity: 'blocked', what: secret, impact: secret,
            blockedActions: [secret], safeEntries: [secret], humanConfirmation: secret, sessionId: rawId,
            counters: { unknownTypeRecords: 2, checked: 7 },
          },
          {
            code: 'cas-blob-not-regular', severity: 'blocked', what: secret, impact: secret,
            blockedActions: [secret], safeEntries: [secret], humanConfirmation: secret,
            counters: { irregular: 1, checked: 7 },
          },
        ],
      },
      boundaries: ['fixed boundary text'],
    }
    const report = buildReport(result)
    const raw = JSON.stringify(report)
    expect(raw.includes(secret)).toBe(false)
    expect(raw.includes(rawId)).toBe(false)
    const findings = (report.diagnosis as { findings: Array<Record<string, unknown>> }).findings
    const typeFinding = findings.find(f => f.code === 'cas-record-type-unknown')
    expect(typeFinding, 'cas-record-type-unknown must be a whitelisted code, not unknown-finding').toBeTruthy()
    expect(typeFinding?.severity).toBe('blocked')
    expect(typeFinding?.counters).toEqual({ unknownTypeRecords: 2, checked: 7 })
    expect(typeFinding?.session).toBe('session-0001')
    const irregularFinding = findings.find(f => f.code === 'cas-blob-not-regular')
    expect(irregularFinding, 'cas-blob-not-regular must be a whitelisted code, not unknown-finding').toBeTruthy()
    expect(irregularFinding?.severity).toBe('blocked')
    expect(irregularFinding?.counters).toEqual({ irregular: 1, checked: 7 })
  })
})
