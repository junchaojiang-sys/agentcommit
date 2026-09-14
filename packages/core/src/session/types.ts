import type { Change } from '../diff/types.js'
import type { Conflict } from '../restore/types.js'

/**
 * Lifecycle states of a Session. See docs/TRANSACTION_MODEL.md §1.1.
 *
 * `rollback_failed` is sourced from the plan's rollback-atomicity rules (§8.3):
 * a failed rollback keeps its restore plan and must never be marked `rolled_back`.
 */
export const SessionStatus = {
  /** Created but pre-scan not finished. */
  Ready: 'ready',
  /** Pre-manifest captured and protected content stored in the CAS. */
  Snapshot: 'snapshot',
  /** Agent process is running. */
  Running: 'running',
  /** Post-scan complete; changes ready for diff / commit / rollback. */
  Review: 'review',
  /** User accepted the session's changes (not a Git commit). */
  Committed: 'committed',
  /** All restore actions executed and post-restore hash verification passed. */
  RolledBack: 'rolled_back',
  /** Rollback failed mid-way; plan retained for retry. */
  RollbackFailed: 'rollback_failed',
  /** Session could not complete (setup failure, fatal interrupt). */
  Failed: 'failed',
  /**
   * Operator explicitly terminated tracking of an interrupted session (P4
   * `resolve --abandon`). Evidence is preserved; this is NOT a commit, NOT a
   * rollback, and does not claim any background process stopped.
   */
  Abandoned: 'abandoned',
} as const

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus]

/**
 * Disposition record for `resolve --abandon` (P4, user-confirmed D1–D4).
 * Stored inside the Session record itself so the status change and its
 * evidence persist in one atomic write. Nothing is ever deleted.
 */
export interface SessionResolution {
  kind: 'abandoned'
  /** ISO-8601 UTC. */
  at: string
  /** Pre manifest that was in effect; kept for evidence linkage. */
  preManifestRef: string
  /** How the original wrapper process state was established. */
  pidEvidence:
    | 'proved-dead-local'
    | 'unverifiable-no-lock-record'
  /** Whether a workspace lock existed when the disposition started. */
  lockExisted: boolean
  /** Whether the lock held by the resolve operation was released at the end. */
  lockReleased: boolean
  /**
   * The operator's declaration, recorded as a declaration only. AgentCommit
   * does not prove that detached child processes exited.
   */
  userDeclaration: {
    taskStoppedConfirmed: boolean
    childStopProven: false
    confirmedAt: string
    transport: 'interactive-two-step'
  }
  /** Optional free-text reason supplied by the operator. */
  note?: string
}

export interface AgentInfo {
  /** Adapter kind, e.g. 'codex' | 'claude' | 'zcode' | 'deepseek' | 'generic'. */
  kind: string
  /** Resolved launch command. */
  command: string
  /** Agent version when detectable. */
  version?: string
}

export interface SessionVerification {
  /** Agent process exit code; null when killed by signal. */
  exitCode: number | null
  /** Post-run integrity checks performed (e.g. 'post-scan', 'blob-verify'). */
  checks: string[]
}

/**
 * One transaction: a single agent execution inside a single workspace.
 * Reserved fields must not collide with future action records
 * (reversible/compensable/irreversible tool classification, V0.3+).
 */
export interface Session {
  id: string
  workspaceId: string
  agent: AgentInfo
  /** ISO-8601 UTC timestamp. */
  startedAt: string
  endedAt?: string
  status: SessionStatus
  /** Manifest id of the pre-run scan. */
  preManifestRef?: string
  /** Manifest id of the post-run scan. */
  postManifestRef?: string
  changes: Change[]
  conflicts: Conflict[]
  verification?: SessionVerification
  /** Present only after an explicit `resolve --abandon` disposition (P4). */
  resolution?: SessionResolution
}
