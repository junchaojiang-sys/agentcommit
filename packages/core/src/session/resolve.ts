import os from 'node:os'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { loadManifest } from '../snapshot/manifest.js'
import { loadRestoreJournal } from '../restore/journal.js'
import { acquireLock, readLock, releaseLock, type LockReadState } from '../storage/lock.js'
import { resolveStateRoot } from '../storage/paths.js'
import { resolveWorkspace } from '../storage/discovery.js'
import { persistSession, loadSession } from '../storage/session-store.js'
import { listWorkspaceSessions, type WorkspaceSessionOptions } from './queries.js'
import { SessionStatus, type Session, type SessionResolution } from './types.js'

/**
 * P4 crashed-running disposition (user-confirmed D1–D4).
 *
 * `resolveSessionAbandon` terminates tracking of ONE interrupted session that is
 * structurally valid, has a trusted Pre and no Post. Semantics (frozen):
 * - keeps every workspace file and every piece of evidence (Session record,
 *   Manifests, Journals, CAS) — nothing is deleted;
 * - is NOT a commit, NOT a rollback, and does not claim the wrapper's detached
 *   children stopped — the operator's statement is recorded as a declaration;
 * - refuses (fail closed) on: any status other than `running` (except the
 *   idempotent already-abandoned retry), missing/invalid Pre, an existing Post,
 *   any restore journal (unfinished OR corrupt), alive/foreign/unreadable locks,
 *   and any state that cannot be explained by the current contract;
 * - takes exclusive operation right through the FROZEN lock protocol
 *   (`acquireLock` deterministic stale takeover) — it never deletes a lock and
 *   then mutates state outside that protocol;
 * - after taking the lock it re-verifies identity and every structural criterion
 *   before the single atomic persistence of status + disposition record;
 * - on failure it releases only a lock it still owns; on process death the
 *   resolve lock remains and the retry takes it over deterministically.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface AbandonSessionOptions extends WorkspaceSessionOptions {
  sessionId: string
  /** Recorded verbatim; the CLI collects this via two interactive confirmations. */
  userDeclaration: {
    taskStoppedConfirmed: boolean
    confirmedAt: string
  }
  note?: string
}

/** Read-only preflight options: no operator declaration needed for classification. */
export type ClassifyAbandonmentOptions = Omit<AbandonSessionOptions, 'userDeclaration' | 'note'>

export interface AbandonClassification {
  eligible: boolean
  refusalReason?: string
  session?: Pick<Session, 'id' | 'status' | 'startedAt' | 'preManifestRef' | 'postManifestRef'>
  pidEvidence: 'proved-dead-local' | 'unverifiable-no-lock-record' | 'holder-alive' | 'foreign-host' | 'lock-unreadable'
  lockExisted: boolean
  alreadyAbandoned: boolean
  consequences: string[]
}

export interface AbandonResult {
  session: Session
  resolution: SessionResolution
  pidEvidence: AbandonClassification['pidEvidence']
  lockExisted: boolean
  lockReleased: boolean
  alreadyAbandoned: boolean
}

interface Identity {
  workspaceRoot: string
  workspaceId: string
  stateRoot: string
}

function roots(options: { workspaceRoot: string; stateRoot?: string }): Identity {
  const workspace = resolveWorkspace(options.workspaceRoot)
  return {
    workspaceRoot: workspace.root,
    workspaceId: workspace.config.workspaceId,
    stateRoot: options.stateRoot ?? resolveStateRoot(),
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function classifyLock(lock: LockReadState, classification: AbandonClassification): boolean {
  // Returns false when the lock state alone makes the disposition impossible.
  classification.lockExisted = lock.state !== 'absent'
  if (lock.state === 'unreadable') {
    classification.pidEvidence = 'lock-unreadable'
    classification.refusalReason = 'The workspace lock file exists but cannot be parsed; ownership cannot be proven.'
    return false
  }
  if (lock.state === 'readable') {
    if (lock.content.hostname !== os.hostname()) {
      classification.pidEvidence = 'foreign-host'
      classification.refusalReason = `The lock is held on another host ("${lock.content.hostname}"); resolve on that host.`
      return false
    }
    if (pidAlive(lock.content.pid)) {
      classification.pidEvidence = 'holder-alive'
      classification.refusalReason = `A live local process (pid ${lock.content.pid}) holds the workspace; it cannot be proven dead.`
      return false
    }
    classification.pidEvidence = 'proved-dead-local'
  } else {
    // A missing lock is NOT proof of anything: recorded as unverifiable.
    classification.pidEvidence = 'unverifiable-no-lock-record'
  }
  return true
}

/** Read-only classification used by the CLI to display what would happen. */
export function classifyAbandonment(options: ClassifyAbandonmentOptions): AbandonClassification {
  const classification: AbandonClassification = {
    eligible: false, pidEvidence: 'lock-unreadable', lockExisted: false,
    alreadyAbandoned: false,
    consequences: [
      'Terminates tracking of this session. The workspace files stay exactly as they are.',
      'This is not a commit and not a rollback; no Post/ChangeSet is fabricated.',
      'The Session record, its Pre manifest, journals and CAS blobs are preserved.',
      'A newer abandoned session blocks automatic selection of older recoverable sessions.',
    ],
  }
  if (!SAFE_ID.test(options.sessionId)) {
    classification.refusalReason = 'Session id is not a safe identifier.'
    return classification
  }
  const identity = roots(options)
  let sessions: Session[]
  try {
    sessions = listWorkspaceSessions({ workspaceRoot: identity.workspaceRoot, stateRoot: identity.stateRoot })
  } catch (error) {
    classification.refusalReason = `State cannot be enumerated: ${(error as Error).message.slice(0, 160)}`
    return classification
  }
  const target = sessions.find(s => s.id === options.sessionId)
  if (!target) {
    classification.refusalReason = `Session ${options.sessionId} does not exist in this workspace.`
    return classification
  }
  classification.session = {
    id: target.id, status: target.status, startedAt: target.startedAt,
    preManifestRef: target.preManifestRef, postManifestRef: target.postManifestRef,
  }
  if (target.status === SessionStatus.Abandoned) {
    if (validAbandonedResolution(target)) {
      classification.alreadyAbandoned = true
    } else {
      classification.refusalReason = 'The session is abandoned but its resolution record is missing or inconsistent with its Pre reference; failing closed — no fabricated history.'
      return classification
    }
  }
  if (!classifyLock(readLock(identity.stateRoot, identity.workspaceId), classification)) return classification
  if (classification.alreadyAbandoned) {
    classification.eligible = true // idempotent completion path
    return classification
  }
  const structural = structuralRefusal(identity, target)
  if (structural) {
    classification.refusalReason = structural
    return classification
  }
  classification.eligible = true
  return classification
}

/** D4 structural criteria: running + trusted bound Pre + no Post + no journal. */
function structuralRefusal(identity: Identity, target: Session): string | undefined {
  if (target.status !== SessionStatus.Running) {
    return target.status === SessionStatus.Review
      ? 'The session finished and awaits review — use commit / rollback instead of abandon.'
      : `Only an interrupted running session can be abandoned; this one is "${target.status}".`
  }
  if (!target.preManifestRef) {
    return 'The running session has no Pre manifest; its origin cannot be explained by the current contract, so it stays fail-closed.'
  }
  if (target.postManifestRef) {
    return 'The session already has a Post snapshot — this is not a crashed-wrapper case; use review flows.'
  }
  try {
    const pre = loadManifest(identity.stateRoot, identity.workspaceId, target.preManifestRef)
    if (pre.sessionId !== target.id || pre.workspaceId !== identity.workspaceId) {
      return 'The Pre manifest is not bound to this session; refusing to abandon on inconsistent evidence.'
    }
  } catch (error) {
    return `The Pre manifest cannot be loaded: ${(error as Error).message.slice(0, 160)}`
  }
  try {
    const journal = loadRestoreJournal(identity.stateRoot, identity.workspaceId, target.id)
    if (journal !== undefined) {
      return 'An unfinished restore journal exists for this session — resume or complete the restore first; abandon would orphan it.'
    }
  } catch {
    return 'The restore journal for this session exists but is corrupt; refusing to abandon over unreadable evidence.'
  }
  return undefined
}

function validAbandonedResolution(session: Session): boolean {
  const res = session.resolution
  return session.status === SessionStatus.Abandoned && res !== undefined &&
    res.kind === 'abandoned' && typeof res.at === 'string' &&
    session.preManifestRef !== undefined && res.preManifestRef === session.preManifestRef
}

function finishAlreadyAbandoned(identity: Identity, target: Session, lock: LockReadState): AbandonResult {
  let lockReleased = false
  if (lock.state === 'readable' && lock.content.sessionId === target.id &&
      lock.content.hostname === os.hostname() && !pidAlive(lock.content.pid)) {
    // Finish the interrupted bookkeeping: take the stale resolve lock, then release it.
    acquireLock(identity.stateRoot, {
      workspaceId: identity.workspaceId, sessionId: target.id, agentCommand: '(resolve-abandon)',
    })
    lockReleased = releaseLock(identity.stateRoot, identity.workspaceId, target.id)
  }
  const session = loadSession(identity.stateRoot, identity.workspaceId, target.id)
  if (!validAbandonedResolution(session)) {
    // Fail closed: never fabricate a confirmation, timestamp, or Pre reference for a
    // torn or inconsistent history. The operator must inspect the state instead.
    throw new AgentCommitError(ErrorCodes.Conflict, 'Abandoned session lacks a valid, bound resolution record (resolution missing, wrong kind, or Pre mismatch); refusing to complete from fabricated history.')
  }
  const resolution: SessionResolution = session.resolution!
  return {
    session,
    resolution,
    pidEvidence: resolution.pidEvidence,
    lockExisted: lock.state !== 'absent', lockReleased, alreadyAbandoned: true,
  }
}

export async function resolveSessionAbandon(options: AbandonSessionOptions): Promise<AbandonResult> {
  if (options.userDeclaration?.taskStoppedConfirmed !== true) {
    throw new AgentCommitError(ErrorCodes.Conflict, 'Abandon requires the operator declaration that the task stopped; none was recorded.')
  }
  const identity = roots(options)
  const lock = readLock(identity.stateRoot, identity.workspaceId)
  const sessions = listWorkspaceSessions({ workspaceRoot: identity.workspaceRoot, stateRoot: identity.stateRoot })
  const target = sessions.find(s => s.id === options.sessionId)
  if (!target) throw new AgentCommitError(ErrorCodes.Conflict, `Session ${options.sessionId} does not exist in this workspace.`)
  if (target.status === SessionStatus.Abandoned) return finishAlreadyAbandoned(identity, target, lock)

  // Classification must be eligible BEFORE taking the exclusive right (the CLI
  // has displayed exactly this classification to the operator).
  const preflight = classifyAbandonment(options)
  if (!preflight.eligible) {
    throw new AgentCommitError(ErrorCodes.Conflict, `Abandon refused: ${preflight.refusalReason}`)
  }

  // Exclusive operation right via the frozen lock protocol (stale takeover or
  // fresh create — never a manual delete-then-act).
  acquireLock(identity.stateRoot, {
    workspaceId: identity.workspaceId, sessionId: target.id, agentCommand: '(resolve-abandon)',
  })
  let released = false
  try {
    // Re-verify identity and every structural criterion under the lock. The lock
    // itself is now OURS (pid = this process), so the lock-based pid evidence
    // from the preflight classification stands and is not re-derived here.
    const lockedSessions = listWorkspaceSessions({ workspaceRoot: identity.workspaceRoot, stateRoot: identity.stateRoot })
    const current = lockedSessions.find(s => s.id === options.sessionId)
    if (!current || current.status !== SessionStatus.Running || current.preManifestRef !== target.preManifestRef ||
        current.postManifestRef !== undefined) {
      throw new AgentCommitError(ErrorCodes.Conflict, 'Session state changed while taking the exclusive right; abandoning refused, nothing was modified.')
    }
    const structural = structuralRefusal(identity, current)
    if (structural) throw new AgentCommitError(ErrorCodes.Conflict, `Abandon refused after re-verification: ${structural}`)

    const resolution: SessionResolution = {
      kind: 'abandoned',
      at: new Date().toISOString(),
      preManifestRef: current.preManifestRef!,
      pidEvidence: preflight.pidEvidence === 'proved-dead-local' ? 'proved-dead-local' : 'unverifiable-no-lock-record',
      lockExisted: lock.state !== 'absent',
      lockReleased: false,
      userDeclaration: {
        taskStoppedConfirmed: true,
        childStopProven: false,
        confirmedAt: options.userDeclaration.confirmedAt,
        transport: 'interactive-two-step',
      },
      ...(options.note !== undefined ? { note: options.note } : {}),
    }
    // One atomic write carries the terminal state and the disposition evidence.
    persistSession(identity.stateRoot, identity.workspaceId, {
      ...current, status: SessionStatus.Abandoned, endedAt: resolution.at, resolution,
    })
    released = releaseLock(identity.stateRoot, identity.workspaceId, target.id)
    const persisted = loadSession(identity.stateRoot, identity.workspaceId, target.id)
    if (persisted.status !== SessionStatus.Abandoned || persisted.resolution?.kind !== 'abandoned') {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Abandon persistence could not be verified.')
    }
    return {
      session: persisted, resolution: persisted.resolution,
      pidEvidence: resolution.pidEvidence, lockExisted: resolution.lockExisted,
      lockReleased: released, alreadyAbandoned: false,
    }
  } catch (error) {
    if (!released) releaseLock(identity.stateRoot, identity.workspaceId, target.id) // ownership-checked; no-op if taken over
    throw error
  }
}
