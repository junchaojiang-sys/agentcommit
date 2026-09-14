import { randomUUID } from 'node:crypto'
import { Session, SessionStatus } from '../session/types.js'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import type { CasStore } from '../cas/types.js'
import type { Manifest, ProtectionPolicySnapshot } from './types.js'
import { createIgnoreEngineFromPolicy } from './ignore.js'
import { scanWorkspace } from './scanner.js'
import { buildManifest, buildProtectionSummary, loadManifest, persistManifest } from './manifest.js'
import { FSCasStore } from '../cas/fs-cas.js'
import { resolveStateRoot } from '../storage/paths.js'
import { resolveWorkspace } from '../storage/discovery.js'
import { loadSession, persistSession } from '../storage/session-store.js'
import { sessionAdmission } from '../storage/admission.js'
import type { ProtectionSummary } from './types.js'

export interface CreatePostSnapshotOptions {
  /** Existing session id (must already have a pre-manifest). */
  sessionId: string
  /** Explicit workspace root (must contain .agentcommit.json); skips discovery. */
  workspaceRoot?: string
  /** Overrides the state directory (test/sandbox isolation hook). */
  stateRoot?: string
  /** Injectable CAS (test seam); defaults to FSCasStore. */
  cas?: CasStore
}

export interface PostSnapshotResult {
  session: Session
  postManifest: Manifest
  summary: ProtectionSummary
  preManifest: Manifest
}

/**
 * Phase 2-A: build the Post Manifest for an EXISTING session, reusing the Pre
 * manifest's frozen ProtectionPolicySnapshot (never re-reading live config —
 * a mid-session `.agentcommitignore` edit is data, not policy). Hard rules:
 * - Pre and Post must share workspace, session and frozen policy; mismatches
 *   are rejected (STATE_CORRUPT).
 * - Pre manifests and existing CAS content are immutable; the Post is a new
 *   manifest id.
 * - A failed post scan persists the session as `failed` and produces NO post
 *   manifest — never a review-able baseline.
 * - Admission check first: unfinished recovery sessions (e.g. rollback_failed)
 *   block a new post scan even though the old holder's pid is gone.
 */
export async function createPostSnapshot(
  options: CreatePostSnapshotOptions,
): Promise<PostSnapshotResult> {
  const startDir = options.workspaceRoot ?? process.cwd()
  const resolved = resolveWorkspace(startDir)
  const stateRoot = options.stateRoot ?? resolveStateRoot()
  const wsId = resolved.config.workspaceId

  // Admission (read-only): an unfinished recovery/active session for this
  // workspace blocks new post observation, even if its holder process is gone.
  const admission = sessionAdmission(stateRoot, wsId, {
    excludeSessionId: options.sessionId,
  })
  if (!admission.eligible) {
    throw new AgentCommitError(
      ErrorCodes.WorkspaceLocked,
      `Workspace has unfinished session(s): ${admission.blockers.join('; ')}`,
    )
  }

  const session = loadSession(stateRoot, wsId, options.sessionId)
  if (!session.preManifestRef) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Session ${options.sessionId} has no pre-manifest; run a pre-snapshot first.`,
    )
  }
  const pre = loadManifest(stateRoot, wsId, session.preManifestRef)

  // Binding: same workspace, same session, same frozen policy.
  if (pre.workspaceId !== wsId || pre.sessionId !== session.id) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      'Pre manifest is not bound to this session/workspace.',
    )
  }
  const policy: ProtectionPolicySnapshot = pre.protectionPolicy
  if (!policy || policy.maxFileSizeBytes !== pre.maxFileSizeBytes) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      'Pre manifest carries an inconsistent protection policy.',
    )
  }

  try {
    // The frozen policy — captured at pre-snapshot — defines the entire scan
    // universe. Live .agentcommitignore/config changes are session DATA if they
    // happen now; they never redefine protection mid-transaction.
    const ignore = createIgnoreEngineFromPolicy(policy)
    const cas = options.cas ?? new FSCasStore(stateRoot)
    const scan = await scanWorkspace({
      root: resolved.root,
      ignore,
      maxFileSizeBytes: policy.maxFileSizeBytes,
      cas,
    })

    const postManifest = buildManifest({
      workspaceId: wsId,
      sessionId: session.id,
      protectionPolicy: policy,
      maxFileSizeBytes: policy.maxFileSizeBytes,
      scan,
      id: randomUUID(),
    })
    persistManifest(stateRoot, wsId, postManifest)

    const updated: Session = {
      ...session,
      status: SessionStatus.Review,
      postManifestRef: postManifest.id,
    }
    persistSession(stateRoot, wsId, updated)

    return {
      session: updated,
      postManifest,
      summary: buildProtectionSummary(postManifest),
      preManifest: pre,
    }
  } catch (error) {
    // No complete post ⇒ never review; never guess a restore plan.
    const failed: Session = {
      ...session,
      status: SessionStatus.Failed,
      endedAt: new Date().toISOString(),
    }
    try {
      persistSession(stateRoot, wsId, failed)
    } catch {
      // the original error matters more
    }
    throw error
  }
}
