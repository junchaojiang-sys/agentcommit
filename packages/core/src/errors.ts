/** Stable machine-readable error codes for programmatic handling. */
export const ErrorCodes = {
  /** Rollback refused: current state differs from the session's post state. */
  Conflict: 'CONFLICT',
  /** A referenced pre-blob does not exist. */
  BlobMissing: 'BLOB_MISSING',
  /** A blob's bytes do not re-hash to its address. */
  BlobCorrupt: 'BLOB_CORRUPT',
  /** Session/manifest metadata failed an integrity check. */
  StateCorrupt: 'STATE_CORRUPT',
  /** Path type cannot be protected on this platform. */
  UnsupportedFile: 'UNSUPPORTED_FILE',
  /** Workspace not initialized (no .agentcommit.json). */
  WorkspaceNotInitialized: 'WORKSPACE_NOT_INITIALIZED',
  /** Workspace already initialized (.agentcommit.json exists). */
  WorkspaceAlreadyInitialized: 'WORKSPACE_ALREADY_INITIALIZED',
  /** Another AgentCommit process holds the workspace lock. */
  WorkspaceLocked: 'WORKSPACE_LOCKED',
  /** Feature exists in the spec but is not implemented yet. */
  NotImplemented: 'NOT_IMPLEMENTED',
  /** File mutated while being read for snapshot — never stored as baseline. */
  FileChangedDuringSnapshot: 'FILE_CHANGED_DURING_SNAPSHOT',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export class AgentCommitError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentCommitError'
    this.code = code
  }
}
