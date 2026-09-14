export const ConflictKinds = {
  /** Modified path: current content differs from the session's post state. */
  UserModifiedAfterSession: 'user-modified-after-session',
  /** Created path: user edited the file the agent created. */
  UserEditedCreatedFile: 'user-edited-created-file',
  /** Deleted path: user created a new file where the agent deleted one. */
  PathRecreatedAfterDelete: 'path-recreated-after-delete',
  /** Pre-blob missing/corrupt, or the change was never protectable. */
  Unrecoverable: 'unrecoverable',
} as const

export type ConflictKind = (typeof ConflictKinds)[keyof typeof ConflictKinds]

/** A path AgentCommit refuses to restore without explicit force. */
export interface Conflict {
  path: string
  kind: ConflictKind
  /** SHA-256 of the path's content right now, when readable. */
  currentHash?: string
  /** SHA-256 the rollback engine expected (the session's post state). */
  expectedPostHash?: string
  /** Canonical fingerprint of Current used by an explicit force authorization. */
  currentFingerprint?: string
  /** Human-readable explanation for the review output. */
  message: string
}

export const RestoreActionTypes = {
  /** Write blob content to the path via temp file + atomic rename. */
  WriteFile: 'write-file',
  /** Remove a path created by the session. Always executed last. */
  DeletePath: 'delete-path',
  /** Recreate a symlink/junction pointing at target (never followed). */
  RestoreSymlink: 'restore-symlink',
  /** Restore mode/permissions where the platform supports it. */
  RestoreMetadata: 'restore-metadata',
} as const

export type RestoreActionType = (typeof RestoreActionTypes)[keyof typeof RestoreActionTypes]

/** What the Current observation looked like when the plan was built. */
export const ExpectedCurrentStates = {
  MatchesPost: 'matches-post',
  MatchesPre: 'matches-pre',
  Absent: 'absent',
  Differs: 'differs',
  Unknown: 'unknown',
} as const

export type ExpectedCurrentState =
  (typeof ExpectedCurrentStates)[keyof typeof ExpectedCurrentStates]

export interface RestoreAction {
  /** Stable id within the plan, e.g. 'action-001'. */
  id: string
  type: RestoreActionType
  path: string
  /** CAS address of the content to write (WriteFile). */
  blobHash?: string
  /** Link target (RestoreSymlink). */
  target?: string
  /** Expected mode bits, when known (RestoreMetadata). */
  mode?: number
  /** What Current looked like at planning time. */
  expectedCurrent: ExpectedCurrentState
  /** Set when the action waits on an undecided product question (never auto-run). */
  requiresDecision?: string
  /** Execution ordinal; deletions sort after all writes. */
  order: number
}

/**
 * A read-only restore plan: a verified-to-execute rollback RECOMMENDATION bound
 * to one session's Pre/Post state (docs/TRANSACTION_MODEL.md §7). Building or
 * persisting it is NOT an execution permit — Phase 2-B must re-verify Current
 * before performing any action. Non-empty conflicts or blocked reasons mean the
 * plan is not executable without explicit force, and even force never covers
 * blocked items. Core defaults to force=false; the CLI owns the
 * double-confirmation flow.
 */
export interface RestorePlan {
  schemaVersion: 1
  planId: string
  workspaceId: string
  sessionId: string
  /** Canonical real paths added by prepareRestore (P2-B root binding). */
  workspaceRootReal?: string
  stateRootReal?: string
  preManifestRef: string
  postManifestRef: string
  /** Digest of the frozen ProtectionPolicySnapshot in force for this plan. */
  policyDigest: string
  /** Explicit scope (path prefix) selected by the caller; absent = full scope. */
  scope?: string
  /** SHA-256 over the canonical serialized plan (integrity on load). */
  planDigest: string
  actions: RestoreAction[]
  conflicts: Conflict[]
  /** Paths/reasons that could not be planned safely at all. */
  blocked: Array<{ path?: string; reason: string }>
  /** Coverage gaps the user must understand (e.g. ignored/unplannable areas). */
  coverageWarnings: string[]
  /** True iff every referenced pre-blob was present and hash-verified. */
  verifiedBlobs: boolean
  force: boolean
}

export interface RestoreForceAuthorization {
  schemaVersion: 1
  sessionId: string
  planDigest: string
  conflicts: Array<{ path: string; currentFingerprint: string }>
}

export const RestoreHookPoints = [
  'after-intent',
  'before-action',
  'temp-write',
  'after-replace',
  'after-delete',
  'after-verified',
  'after-journal-completed',
  'before-journal-write',
] as const

export type RestoreHookPoint = (typeof RestoreHookPoints)[number]

export interface RestoreHookContext {
  action: RestoreAction
  attemptId: string
  tempPath?: string
  /** Fingerprint recorded immediately before the action intent. */
  beforeFingerprint?: string
}

export type RestoreExecutionHooks = Partial<
  Record<RestoreHookPoint, (context: RestoreHookContext) => void | Promise<void>>
>

export interface RestoreExecutionResult {
  status: 'succeeded' | 'partial' | 'rejected' | 'retryable'
  workspaceId: string
  sessionId: string
  planDigest: string
  attemptId?: string
  completedPaths: string[]
  pendingPaths: string[]
  conflicts: Conflict[]
  error?: string
}

export interface RestoreJournalAction {
  actionId: string
  path: string
  status: 'intent' | 'verified'
  beforeFingerprint: string
  expectedFingerprint: string
  tempPath?: string
  verifiedAt?: string
  /** Earlier attempt whose persisted intent was observed already applied. */
  recoveredFromAttemptId?: string
}

export interface RestoreJournalAttempt {
  id: string
  startedAt: string
  status: 'running' | 'failed' | 'completed'
  actions: RestoreJournalAction[]
  endedAt?: string
  error?: string
}

export interface RestoreJournal {
  schemaVersion: 1
  workspaceId: string
  sessionId: string
  planDigest: string
  plan: RestorePlan
  status: 'prepared' | 'executing' | 'partial' | 'completed'
  attempts: RestoreJournalAttempt[]
  /** Verified paths carried across a completed scoped plan into a whole plan. */
  completedReceipts?: Array<{ path: string; expectedFingerprint: string; planId: string; planDigest: string; attemptId: string }>
  journalDigest: string
}
