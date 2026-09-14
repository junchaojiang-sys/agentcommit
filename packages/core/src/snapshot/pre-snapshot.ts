import { randomUUID } from 'node:crypto'
import type { Session } from '../session/types.js'
import { SessionStatus } from '../session/types.js'
import { newSessionRecord, persistSession } from '../storage/session-store.js'
import { acquireLock, releaseLock } from '../storage/lock.js'
import { resolveStateRoot } from '../storage/paths.js'
import { resolveWorkspace } from '../storage/discovery.js'
import { sessionAdmission } from '../storage/admission.js'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { FSCasStore } from '../cas/fs-cas.js'
import { captureProtectionPolicy } from './policy.js'
import { createIgnoreEngineFromPolicy } from './ignore.js'
import { scanWorkspace } from './scanner.js'
import { buildManifest, buildProtectionSummary, persistManifest } from './manifest.js'
import type { Manifest, ProtectionSummary } from './types.js'

export interface CreatePreSnapshotOptions {
  /**
   * Where workspace discovery starts (frozen cwd parent-walk). Ignored when
   * `workspaceRoot` is given explicitly.
   */
  cwd?: string
  /** Explicit workspace root (must contain .agentcommit.json); skips discovery. */
  workspaceRoot?: string
  /** Overrides the state directory (test/sandbox isolation hook). */
  stateRoot?: string
  /** Agent identity recorded on the session; defaults to a generic marker. */
  agent?: { kind: string; command: string; version?: string }
  /** Injectable session id (tests); defaults to a random UUID. */
  sessionId?: string
  /** Injectable CAS (test seam for TOCTOU/integrity scenarios); defaults to FSCasStore. */
  cas?: import('../cas/types.js').CasStore
  /** Keep the owned workspace lock after a successful snapshot (P3 wrapper). */
  retainLockOnSuccess?: boolean
}

export interface PreSnapshotResult {
  session: Session
  manifest: Manifest
  summary: ProtectionSummary
}

/**
 * The frozen Phase 1 chain, end to end (docs/ROADMAP P1):
 *
 *   resolve workspace → acquire lock → scan → protection rules →
 *   hash + persist CAS blobs → persist pre-manifest → session(snapshot) →
 *   Protection Summary data
 *
 * Lock note: standalone calls release the lock when this helper finishes.
 * Phase 3's generic wrapper explicitly requests ownership retention after a
 * successful Pre snapshot and releases that same lock after Post/review.
 */
export async function createPreSnapshot(
  options: CreatePreSnapshotOptions = {},
): Promise<PreSnapshotResult> {
  const startDir = options.workspaceRoot ?? options.cwd ?? process.cwd()
  const resolved = resolveWorkspace(startDir)
  const stateRoot = options.stateRoot ?? resolveStateRoot()
  const sessionId = options.sessionId ?? randomUUID()

  const admission = sessionAdmission(stateRoot, resolved.config.workspaceId)
  if (!admission.eligible && admission.blockers.some((blocker) => blocker.includes('restore journal'))) {
    throw new AgentCommitError(
      ErrorCodes.WorkspaceLocked,
      `Workspace has unfinished restore state: ${admission.blockers.join('; ')}`,
    )
  }

  const lock = acquireLock(stateRoot, {
    workspaceId: resolved.config.workspaceId,
    sessionId,
    ...(options.agent?.command !== undefined ? { agentCommand: options.agent.command } : {}),
  })
  void lock

  let session: Session = newSessionRecord({
    sessionId,
    workspaceId: resolved.config.workspaceId,
    agent: options.agent ?? { kind: 'generic', command: '(pre-snapshot)' },
  })
  let completed = false

  try {
    persistSession(stateRoot, resolved.config.workspaceId, session)

    // Blocker 1: freeze the protection policy BEFORE scanning. The scanner's
    // universe comes exclusively from this snapshot — a mid-session mutation
    // of .agentcommitignore / config can never change the policy.
    const policy = captureProtectionPolicy(resolved.root, resolved.config.maxFileSizeBytes)
    const ignore = createIgnoreEngineFromPolicy(policy)
    const cas = options.cas ?? new FSCasStore(stateRoot)
    const scan = await scanWorkspace({
      root: resolved.root,
      ignore,
      maxFileSizeBytes: policy.maxFileSizeBytes,
      cas,
    })

    const manifest = buildManifest({
      workspaceId: resolved.config.workspaceId,
      sessionId,
      protectionPolicy: policy,
      maxFileSizeBytes: policy.maxFileSizeBytes,
      scan,
    })
    persistManifest(stateRoot, resolved.config.workspaceId, manifest)

    session = {
      ...session,
      status: SessionStatus.Snapshot,
      preManifestRef: manifest.id,
    }
    persistSession(stateRoot, resolved.config.workspaceId, session)

    const summary = buildProtectionSummary(manifest)
    completed = true
    return { session, manifest, summary }
  } catch (error) {
    // Fatal setup/scan error: record failed session for review, then rethrow.
    session = {
      ...session,
      status: SessionStatus.Failed,
      endedAt: new Date().toISOString(),
    }
    try {
      persistSession(stateRoot, resolved.config.workspaceId, session)
    } catch {
      // The original error matters more than a failed bookkeeping write.
    }
    throw error
  } finally {
    if (!completed || options.retainLockOnSuccess !== true) {
      releaseLock(stateRoot, resolved.config.workspaceId, sessionId)
    }
  }
}
