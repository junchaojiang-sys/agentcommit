import ignore from 'ignore'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_IGNORE_PATTERNS, WORKSPACE_IGNORE_FILENAME } from '../config.js'
import {
  IgnoredReasons,
  IgnoredSources,
  type IgnoredBoundary,
  type IgnoredReason,
  type IgnoredSource,
  type ProtectionPolicySnapshot,
} from './types.js'
import { BUILTIN_RULES_VERSION, normalizeIgnoreRules } from './policy.js'

export interface IgnoreEngine {
  /** Whether a workspace-relative path is excluded from protection. */
  isIgnored(relPath: string, isDir: boolean): boolean
  /**
   * Like isIgnored, but returns WHICH boundary matched: the ignored subtree
   * root (or single file), its source (builtin vs .agentcommitignore), and
   * the matched rule text. Null when not ignored. (Blocker 3 disclosure.)
   */
  matchIgnored(relPath: string, isDir: boolean): IgnoredBoundary | null
  /** Human-readable provenance of the active rules (warnings/diagnostics only). */
  sources: string[]
}

interface AttributionCandidate {
  /** Rule text to report (the documented rule, e.g. `node_modules/**`). */
  rule: string
  /** Effective pattern used for single-rule matching (may be the bare dir form). */
  pattern: string
  source: (typeof IgnoredSources)[keyof typeof IgnoredSources]
  reason: (typeof IgnoredReasons)[keyof typeof IgnoredReasons]
}

function normalize(relPath: string): string | null {
  const normalized = relPath.split(path.sep).join('/')
  if (normalized === '' || normalized === '.') return null
  const clean = normalized.replace(/^\.\/+/, '').replace(/\/+$/, '')
  return clean === '' ? null : clean
}

function candidatesFrom(
  rules: readonly string[],
  source: IgnoredSource,
  reason: IgnoredReason,
): AttributionCandidate[] {
  const out: AttributionCandidate[] = []
  for (const rule of rules) {
    out.push({ rule, pattern: rule, source, reason })
    const dirPrefix = /^(.*)\/\*\*$/.exec(rule)
    if (dirPrefix?.[1] !== undefined && dirPrefix[1] !== '') {
      // `X/**` also prunes X itself; attribute back to the documented rule text.
      out.push({ rule, pattern: dirPrefix[1], source, reason })
    }
  }
  return out
}

/**
 * Build an ignore engine from explicit rule lists (Blocker 1: the pre/post
 * scan universe must come from the frozen ProtectionPolicySnapshot, not from
 * re-reading disk). Decisions use builtin + custom combined; attribution
 * reports the first matching custom rule, else the first matching builtin
 * rule, with its source and reason.
 */
export function buildIgnoreEngine(
  builtinRules: readonly string[],
  customRules: readonly string[],
  sources: string[],
): IgnoreEngine {
  const combined = ignore()
  combined.add([...builtinRules])
  combined.add([...customRules])
  // `X/**` rules also prune X itself — BUT only when the rule set contains no
  // negations: a derived bare `X` would override `!X/child` re-inclusions.
  // With negations present we walk excluded trees and match every child
  // individually (correctness over speed).
  const hasNegation = [...builtinRules, ...customRules].some((rule) =>
    rule.trimStart().startsWith('!'),
  )
  if (!hasNegation) {
    for (const rule of [...builtinRules, ...customRules]) {
      const dirPrefix = /^(.*)\/\*\*$/.exec(rule)
      if (dirPrefix?.[1] !== undefined && dirPrefix[1] !== '') combined.add(dirPrefix[1])
    }
  }

  const customCandidates = candidatesFrom(
    customRules,
    IgnoredSources.AgentCommitIgnore,
    IgnoredReasons.AgentCommitIgnore,
  )
  const builtinCandidates = candidatesFrom(
    builtinRules,
    IgnoredSources.Builtin,
    IgnoredReasons.BuiltinRule,
  )

  const ruleMatcherCache = new Map<string, ignore.Ignore>()
  function singleRuleIgnores(pattern: string, clean: string, isDir: boolean): boolean {
    let m = ruleMatcherCache.get(pattern)
    if (m === undefined) {
      m = ignore()
      m.add(pattern)
      ruleMatcherCache.set(pattern, m)
    }
    if (m.ignores(clean)) return true
    return isDir && m.ignores(`${clean}/`)
  }

  const isIgnored = (relPath: string, isDir: boolean): boolean => {
    const clean = normalize(relPath)
    if (clean === null) return false
    if (combined.ignores(clean)) return true
    return isDir && combined.ignores(`${clean}/`)
  }

  const matchIgnored = (relPath: string, isDir: boolean): IgnoredBoundary | null => {
    const clean = normalize(relPath)
    if (clean === null) return null
    // Combined decision FIRST (negation-aware); attribution only for paths
    // the engine actually ignores.
    const ignored =
      combined.ignores(clean) || (isDir && combined.ignores(`${clean}/`))
    if (!ignored) return null
    const matches = (candidate: AttributionCandidate): boolean =>
      singleRuleIgnores(candidate.pattern, clean, isDir)
    const candidate = customCandidates.find(matches) ?? builtinCandidates.find(matches)
    if (candidate === undefined) {
      // Ignored by the combined matcher but attributable to no single rule
      // (e.g. negation interplay): still disclosed, with the combined set.
      return {
        path: clean,
        kind: isDir ? 'directory' : 'file',
        source: customRules.length > 0 ? IgnoredSources.AgentCommitIgnore : IgnoredSources.Builtin,
        rule: [...customRules, ...builtinRules].join(' | '),
        reason:
          customRules.length > 0
            ? IgnoredReasons.AgentCommitIgnore
            : IgnoredReasons.BuiltinRule,
      }
    }
    return {
      path: clean,
      kind: isDir ? 'directory' : 'file',
      source: candidate.source,
      rule: candidate.rule,
      reason: candidate.reason,
    }
  }

  return { isIgnored, matchIgnored, sources: [...sources] }
}

/**
 * Disk-based convenience loader (diagnostics/tests only). The transaction path
 * MUST use buildIgnoreEngine(capturedPolicy.builtinRules, capturedPolicy.ignoreRules)
 * so pre/post scans share one frozen policy (Blocker 1).
 */
export function createIgnoreEngine(workspaceRoot: string): IgnoreEngine {
  const sources = ['built-in defaults']
  let customRules: string[] = []
  const customPath = path.join(workspaceRoot, WORKSPACE_IGNORE_FILENAME)
  if (existsSync(customPath)) {
    customRules = normalizeIgnoreRules(readFileSync(customPath, 'utf8'))
    sources.push(WORKSPACE_IGNORE_FILENAME)
  }
  return buildIgnoreEngine(DEFAULT_IGNORE_PATTERNS, customRules, sources)
}

/**
 * Build the engine from a frozen policy snapshot (Blocker 1). Validates the
 * policy schema version so a stale/mismatched policy fails closed.
 */
export function createIgnoreEngineFromPolicy(
  policy: ProtectionPolicySnapshot,
): IgnoreEngine {
  if (policy.schemaVersion !== 1) {
    throw new Error(`Unsupported protection policy schema version: ${String(policy.schemaVersion)}`)
  }
  if (policy.builtinRulesVersion !== BUILTIN_RULES_VERSION) {
    throw new Error(
      `Policy builtin rules version ${policy.builtinRulesVersion} does not match this build (${BUILTIN_RULES_VERSION})`,
    )
  }
  const sources =
    policy.ignoreRules.length > 0
      ? ['built-in defaults', WORKSPACE_IGNORE_FILENAME]
      : ['built-in defaults']
  return buildIgnoreEngine([...policy.builtinRules], [...policy.ignoreRules], sources)
}
