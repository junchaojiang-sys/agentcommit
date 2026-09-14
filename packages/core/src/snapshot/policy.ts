import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_IGNORE_PATTERNS, WORKSPACE_IGNORE_FILENAME } from '../config.js'
import type { ProtectionPolicySnapshot } from './types.js'

/** Version of the built-in default rule set (bump when DEFAULT_IGNORE_PATTERNS changes). */
export const BUILTIN_RULES_VERSION = 1

export const POLICY_SCHEMA_VERSION = 1

/**
 * Normalize raw .agentcommitignore text into active rules: drop blanks and
 * `#` comments, strip trailing `\r` and trailing whitespace (git behavior;
 * escaped-trailing-space is not supported — documented subset). Everything
 * else is passed to the matcher untouched (gitignore-style, IQ-03).
 */
export function normalizeIgnoreRules(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, '').replace(/[ \t]+$/, ''))
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Capture the immutable protection policy for a pre-snapshot (Blocker 1).
 * Pure data: no handles, no live references — persistable and reloadable.
 * Phase 2 post-scans MUST build their matcher from this snapshot instead of
 * re-reading a possibly-mutated .agentcommitignore / config.
 */
export function captureProtectionPolicy(
  workspaceRoot: string,
  maxFileSizeBytes: number,
): ProtectionPolicySnapshot {
  const ignorePath = path.join(workspaceRoot, WORKSPACE_IGNORE_FILENAME)
  if (!existsSync(ignorePath)) {
    return freezePolicy({
      schemaVersion: POLICY_SCHEMA_VERSION,
      maxFileSizeBytes,
      builtinRulesVersion: BUILTIN_RULES_VERSION,
      builtinRules: [...DEFAULT_IGNORE_PATTERNS],
      ignoreRules: [],
      ignoreFileSha256: null,
    })
  }
  const raw = readFileSync(ignorePath)
  return freezePolicy({
    schemaVersion: POLICY_SCHEMA_VERSION,
    maxFileSizeBytes,
    builtinRulesVersion: BUILTIN_RULES_VERSION,
    builtinRules: [...DEFAULT_IGNORE_PATTERNS],
    ignoreRules: normalizeIgnoreRules(raw.toString('utf8')),
    ignoreFileSha256: sha256Hex(raw),
  })
}

/** Deep-freeze the snapshot: a captured policy must be immutable (Blocker 1). */
function freezePolicy(policy: ProtectionPolicySnapshot): ProtectionPolicySnapshot {
  return Object.freeze({
    ...policy,
    builtinRules: Object.freeze([...policy.builtinRules]),
    ignoreRules: Object.freeze([...policy.ignoreRules]),
  }) as ProtectionPolicySnapshot
}

/**
 * Canonical integrity digest of a policy snapshot (fixed key order ⇒ stable
 * JSON ⇒ stable hash). Lets Manifest/Session references detect policy drift.
 */
export function policyDigest(policy: ProtectionPolicySnapshot): string {
  const canonical = JSON.stringify({
    schemaVersion: policy.schemaVersion,
    maxFileSizeBytes: policy.maxFileSizeBytes,
    builtinRulesVersion: policy.builtinRulesVersion,
    builtinRules: [...policy.builtinRules],
    ignoreRules: [...policy.ignoreRules],
    ignoreFileSha256: policy.ignoreFileSha256,
  })
  return sha256Hex(Buffer.from(canonical, 'utf8'))
}
