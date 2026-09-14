import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_IGNORE_PATTERNS,
  captureProtectionPolicy,
  createIgnoreEngineFromPolicy,
  normalizeIgnoreRules,
  policyDigest,
} from '@agentcommit/core'
import { makeTempDir, writeTree } from '../helpers.js'

describe('ProtectionPolicySnapshot (Blocker 1: frozen, immutable, reloadable)', () => {
  it('captures builtin defaults + normalized custom rules + content hash', () => {
    const ws = makeTempDir()
    writeTree(ws, {
      '.agentcommitignore': '# comment\n\ntmp/**\n*.secret  \r\n',
    })
    const policy = captureProtectionPolicy(ws, 100 * 1024 * 1024)

    expect(policy.schemaVersion).toBe(1)
    expect(policy.builtinRulesVersion).toBe(1)
    expect(policy.builtinRules).toEqual([...DEFAULT_IGNORE_PATTERNS])
    expect(policy.maxFileSizeBytes).toBe(100 * 1024 * 1024)
    expect(policy.ignoreRules).toEqual(['tmp/**', '*.secret'])
    expect(policy.ignoreFileSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('absent ignore file ⇒ empty rules and null hash', () => {
    const policy = captureProtectionPolicy(makeTempDir(), 123)
    expect(policy.ignoreRules).toEqual([])
    expect(policy.ignoreFileSha256).toBeNull()
    expect(policy.maxFileSizeBytes).toBe(123)
  })

  it('normalizeIgnoreRules drops blanks and comments, keeps the rest verbatim', () => {
    expect(normalizeIgnoreRules('# a\n\n  \n!keep.txt\n logs/**')).toEqual([
      '!keep.txt',
      ' logs/**',
    ])
  })

  it('policy A survives workspace mutation: frozen snapshot + engine stay A', () => {
    const ws = makeTempDir()
    writeTree(ws, { '.agentcommitignore': 'tmp/\n', 'src/a.ts': 'code' })
    const frozen = captureProtectionPolicy(ws, 1024)
    const frozenRules = [...frozen.ignoreRules]
    const frozenDigest = policyDigest(frozen)

    // agent/user mutates the ignore file AFTER the snapshot
    writeFileSync(path.join(ws, '.agentcommitignore'), 'tmp/\nsrc/\n')

    // the in-memory frozen policy is unchanged
    expect(frozen.ignoreRules).toEqual(frozenRules)
    expect(policyDigest(frozen)).toBe(frozenDigest)

    // an engine rebuilt from the FROZEN policy still applies A — not the live file
    const engine = createIgnoreEngineFromPolicy(frozen)
    expect(engine.isIgnored('tmp/x.bin', true)).toBe(true)
    expect(engine.isIgnored('src/a.ts', false)).toBe(false) // 'src/' mutation NOT picked up

    // a fresh capture DOES see the mutation (live ≠ frozen)
    const live = captureProtectionPolicy(ws, 1024)
    expect(live.ignoreRules).toEqual(['tmp/', 'src/'])
    expect(policyDigest(live)).not.toBe(frozenDigest)
  })

  it('builtin rules copies cannot be mutated through the snapshot (deep-frozen)', () => {
    const policy = captureProtectionPolicy(makeTempDir(), 1)
    const before = [...policy.builtinRules]
    const mutable = policy.builtinRules as string[]
    expect(() => mutable.push('everything/**')).toThrow()
    expect([...policy.builtinRules]).toEqual(before)
    expect([...policy.builtinRules]).toEqual([...DEFAULT_IGNORE_PATTERNS])
    expect(() => {
      ;(policy as { ignoreRules: string[] }).ignoreRules.push('x')
    }).toThrow()
  })

  it('digest is stable for identical policies and differs on any change', () => {
    const ws = makeTempDir()
    writeTree(ws, { '.agentcommitignore': 'tmp/\n' })
    const a1 = captureProtectionPolicy(ws, 100)
    const a2 = captureProtectionPolicy(ws, 100)
    expect(policyDigest(a1)).toBe(policyDigest(a2))

    const b = captureProtectionPolicy(ws, 200)
    expect(policyDigest(b)).not.toBe(policyDigest(a1))

    writeFileSync(path.join(ws, '.agentcommitignore'), 'tmp/\nsrc/\n')
    const c = captureProtectionPolicy(ws, 100)
    expect(policyDigest(c)).not.toBe(policyDigest(a1))
  })

  it('engine rebuilt from frozen policy rejects mismatched builtin version', () => {
    const policy = { ...captureProtectionPolicy(makeTempDir(), 1), builtinRulesVersion: 99 }
    expect(() => createIgnoreEngineFromPolicy(policy)).toThrow(/builtin rules version/i)
  })
})
