export type FileRecordType = 'file' | 'symlink' | 'junction' | 'reparse' | 'unsupported'

export const UnprotectedReasons = {
  /** Content larger than the effective per-file cap (OQ-06). */
  FileTooLarge: 'file-too-large',
  /** Special file type AgentCommit cannot snapshot (fifo/socket/device/...). */
  UnsupportedSpecialFile: 'unsupported-special-file',
  /** Could not be read (permissions, locks, race) — recorded, never silently skipped. */
  Inaccessible: 'inaccessible',
  /** Link entry whose policy makes it unrestorable. */
  SymlinkPolicyRejected: 'symlink-policy-rejected',
} as const

export type UnprotectedReason = (typeof UnprotectedReasons)[keyof typeof UnprotectedReasons]

/** Fixed order for deterministic stats/summary output. */
export const ALL_UNPROTECTED_REASONS: readonly UnprotectedReason[] = [
  UnprotectedReasons.FileTooLarge,
  UnprotectedReasons.UnsupportedSpecialFile,
  UnprotectedReasons.Inaccessible,
  UnprotectedReasons.SymlinkPolicyRejected,
]

/** One scanned path in a workspace. Frozen contract: docs/TRANSACTION_MODEL.md §2. */
export interface FileRecord {
  /** Workspace-relative, normalized path (forward slashes, no trailing separator). */
  path: string
  type: FileRecordType
  /** SHA-256 hex digest of content; regular files only. */
  hash?: string
  size: number
  /** POSIX permission bits, best-effort, Unix only (OQ-07, restore is Phase 2). */
  mode?: number
  /**
   * Nanoseconds since epoch, serialized as string — the value exceeds
   * Number.MAX_SAFE_INTEGER and must survive JSON round-trips exactly.
   * REFERENCE ONLY: never a restore criterion.
   */
  mtimeNs?: string
  /** Symlink/junction target; recorded but never followed. */
  symlinkTarget?: string
  /** True iff a restorable snapshot exists for this path (content blob or recorded link target). */
  protected: boolean
  reasonUnprotected?: UnprotectedReason
}

/** Why a path is excluded from protection (ignored — distinct from unprotected). */
export const IgnoredReasons = {
  BuiltinRule: 'ignored-by-builtin-rule',
  AgentCommitIgnore: 'ignored-by-agentcommitignore',
} as const

export type IgnoredReason =
  (typeof IgnoredReasons)[keyof typeof IgnoredReasons]

export const IgnoredSources = {
  Builtin: 'builtin',
  AgentCommitIgnore: '.agentcommitignore',
} as const

export type IgnoredSource = (typeof IgnoredSources)[keyof typeof IgnoredSources]

/**
 * One ignored protection boundary (docs/TRANSACTION_MODEL §4). For a pruned
 * directory subtree only the ROOT is recorded with its matched rule —
 * descendants are not individually enumerated (no Manifest explosion).
 */
export interface IgnoredBoundary {
  path: string
  kind: 'directory' | 'file'
  source: IgnoredSource
  /** The matched gitignore-style rule text. */
  rule: string
  reason: IgnoredReason
}

/** Per-scan counters; all counts are deterministic for a given tree. */
export interface ScanStatistics {
  /** Every entry seen (files, links, dirs — before ignore filtering). */
  scannedEntries: number
  /** Entries excluded by ignore policy (a skipped dir counts once, not its contents). */
  ignoredEntries: number
  /** Regular files whose content was stored in the CAS. */
  protectedFiles: number
  /** Link entries recorded (target kept, never followed). */
  symlinks: number
  /** Entries that changed but are NOT protectable (unprotected paths). */
  unprotected: number
  /** Entries that could not be stat/read at all. */
  unreadableEntries: number
  /** Unprotected/unreadable counts grouped by reason, fixed key order. */
  byReason: Partial<Record<UnprotectedReason, number>>
}

export const MANIFEST_SCHEMA_VERSION = 2

/**
 * Immutable protection policy, captured at pre-snapshot time (P1 rectification,
 * Blocker 1). Post scans (Phase 2) MUST reuse this frozen policy — never
 * re-read a possibly-mutated .agentcommitignore / config. Policy is plain
 * data: persistable, reloadable, and integrity-checkable via policyDigest().
 */
export interface ProtectionPolicySnapshot {
  schemaVersion: 1
  /** Effective per-file cap (OQ-06) at snapshot time. */
  maxFileSizeBytes: number
  /** Version of the built-in default rule set embedded in this build. */
  builtinRulesVersion: number
  /** Frozen copy of the built-in default rules. */
  builtinRules: readonly string[]
  /** Normalized active rules from .agentcommitignore (comments/blanks dropped). */
  ignoreRules: readonly string[]
  /** SHA-256 of raw .agentcommitignore bytes; null when the file is absent. */
  ignoreFileSha256: string | null
}

/**
 * An immutable scan of the workspace at one point in time. The file set and
 * hash mapping are deterministic for a given tree; ids/timestamps are the only
 * varying metadata.
 */
export interface Manifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  id: string
  workspaceId: string
  sessionId: string
  /** ISO-8601 UTC timestamp. */
  createdAt: string
  /** Frozen protection policy for this transaction (Blocker 1). */
  protectionPolicy: ProtectionPolicySnapshot
  /** Effective per-file cap (mirrors protectionPolicy.maxFileSizeBytes). */
  maxFileSizeBytes: number
  /** Sorted by path (code-unit order) for deterministic output. */
  files: FileRecord[]
  /** Ignored protection boundaries — roots + rules, never full descendants. */
  ignored: IgnoredBoundary[]
  stats: ScanStatistics
}

/** Structured Protection Summary data (TRANSACTION_MODEL §4). CLI rendering is Phase 3. */
export interface ProtectionSummary {
  protectedFiles: number
  ignoredEntries: number
  /** Ignored protection boundaries: subtree roots (or single files) + matched rules. */
  ignoredBoundaries: IgnoredBoundary[]
  symlinks: number
  unreadableEntries: number
  /** Every unprotected path, sorted, with reason — never silent. */
  unprotectedPaths: Array<{ path: string; reason: UnprotectedReason; size: number }>
  byReason: Partial<Record<UnprotectedReason, number>>
}
