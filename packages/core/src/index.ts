/**
 * @agentcommit/core — public API surface.
 *
 * Phase 0 froze the types/constants below; Phase 1 adds the working
 * snapshot/CAS/storage/discovery/lock implementations per the frozen specs
 * (docs/ROADMAP P1). Restore/diff/conflict engines arrive in Phase 2; nothing
 * here may grow agent-specific code (docs/ARCHITECTURE.md §4).
 */

// Frozen contracts
export * from './config.js'
export * from './errors.js'
export * from './cas/types.js'
export * from './diff/types.js'
export * from './restore/types.js'
export * from './session/types.js'
export * from './snapshot/types.js'
// Phase 1 implementations
export { FSCasStore } from './cas/fs-cas.js'
export { atomicWriteBytes, atomicWriteJson, readJson, ensureDir } from './storage/atomic.js'
export {
  resolveStateRoot,
  blobsRoot,
  workspacesRoot,
  workspaceDir,
  sessionsDir,
  sessionPath,
  manifestsDir,
  manifestPath,
  locksDir,
  lockPath,
} from './storage/paths.js'
export { defaultConfig, loadConfig, parseConfig } from './storage/config.js'
export {
  initializeWorkspace,
  resolveWorkspace,
  type ResolvedWorkspace,
} from './storage/discovery.js'
export {
  acquireLock,
  releaseLock,
  readLock,
  type LockContent,
  type LockReadState,
} from './storage/lock.js'
export {
  loadSession,
  newSessionRecord,
  persistSession,
  type NewSessionInput,
} from './storage/session-store.js'
export { createIgnoreEngine, buildIgnoreEngine, createIgnoreEngineFromPolicy, type IgnoreEngine } from './snapshot/ignore.js'
export {
  BUILTIN_RULES_VERSION,
  POLICY_SCHEMA_VERSION,
  captureProtectionPolicy,
  normalizeIgnoreRules,
  policyDigest,
} from './snapshot/policy.js'
export { scanWorkspace, type ScanOptions, type ScanResult } from './snapshot/scanner.js'
export {
  buildManifest,
  buildProtectionSummary,
  loadManifest,
  persistManifest,
  type BuildManifestInput,
} from './snapshot/manifest.js'
export {
  createPreSnapshot,
  type CreatePreSnapshotOptions,
  type PreSnapshotResult,
} from './snapshot/pre-snapshot.js'

// Phase 2-A implementations (read-only: post observation, comparison, planning)
export { sessionAdmission, type AdmissionCheck } from './storage/admission.js'
export {
  createPostSnapshot,
  type CreatePostSnapshotOptions,
  type PostSnapshotResult,
} from './snapshot/post-snapshot.js'
export { compareManifests } from './diff/changeset.js'
export { describeChange, type DiffMode, type DiffResult } from './diff/text-diff.js'
export { observeCurrent, type CurrentObservation } from './restore/observe.js'
export {
  buildRestorePlan,
  loadRestorePlan,
  parentLinkEscape,
  planPath,
  saveRestorePlan,
  validateRestorePath,
  type BuildRestorePlanOptions,
  type BuiltRestorePlan,
  restorePlanDigest,
  validateRestorePlanInputs,
} from './restore/plan.js'

// Phase 2-B implementations (journalled, conflict-safe restore execution)
export {
  restoreJournalPath,
  loadRestoreJournal,
  persistRestoreJournal,
  sealRestoreJournal,
  archivedRestoreJournalPath,
} from './restore/journal.js'
export {
  prepareRestore,
  executeRestore,
  observeRestoreFingerprint,
  type PrepareRestoreOptions,
  type ExecuteRestoreOptions,
} from './restore/executor.js'

// Phase 3: generic process wrapper and Session lifecycle queries.
export {
  listWorkspaceSessions,
  inspectSession,
  acceptSession,
  unlockWorkspace,
  type WorkspaceSessionOptions,
  type InspectedSession,
} from './session/queries.js'
export {
  resolveSessionAbandon,
  classifyAbandonment,
  type AbandonSessionOptions,
  type ClassifyAbandonmentOptions,
  type AbandonClassification,
  type AbandonResult,
} from './session/resolve.js'
export {
  runSession,
  type RunSessionOptions,
  type RunSessionResult,
} from './session/lifecycle.js'
export {
  updateAgentRegistration,
  type UpdateAgentRegistrationOptions,
} from './session/registration.js'
