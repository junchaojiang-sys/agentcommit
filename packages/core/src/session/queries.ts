import { lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { compareManifests } from '../diff/changeset.js'
import { archiveRestoreJournal, archivedRestoreJournalPath, loadRestoreJournal, restoreJournalPath } from '../restore/journal.js'
import type { RestoreJournal } from '../restore/types.js'
import { validateRestorePlanInputs } from '../restore/plan.js'
import type { CasStore } from '../cas/types.js'
import { loadManifest } from '../snapshot/manifest.js'
import type { Manifest } from '../snapshot/types.js'
import { policyDigest } from '../snapshot/policy.js'
import { readLock, acquireLock, releaseLock } from '../storage/lock.js'
import { resolveWorkspace } from '../storage/discovery.js'
import { resolveStateRoot, sessionsDir } from '../storage/paths.js'
import { loadSession, persistSession } from '../storage/session-store.js'
import { sessionAdmission } from '../storage/admission.js'
import { SessionStatus, type Session } from './types.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const KNOWN_STATUSES = new Set(Object.values(SessionStatus))

export interface WorkspaceSessionOptions {
  workspaceRoot: string
  stateRoot?: string
}

export interface InspectedSession {
  session: Session
  pre?: Manifest
  post?: Manifest
}

function roots(options: WorkspaceSessionOptions) {
  const workspace = resolveWorkspace(options.workspaceRoot)
  return {
    workspaceRoot: workspace.root,
    workspaceId: workspace.config.workspaceId,
    stateRoot: options.stateRoot ?? resolveStateRoot(),
  }
}

function validateSession(session: Session, expectedId: string, workspaceId: string): void {
  if (!SAFE_ID.test(expectedId) || session.id !== expectedId || session.workspaceId !== workspaceId ||
      !KNOWN_STATUSES.has(session.status) || !Number.isFinite(Date.parse(session.startedAt)) ||
      (session.endedAt !== undefined && !Number.isFinite(Date.parse(session.endedAt))) ||
      typeof session.agent !== 'object' || session.agent === null ||
      typeof session.agent.kind !== 'string' || typeof session.agent.command !== 'string' ||
      !Array.isArray(session.changes) || !Array.isArray(session.conflicts) ||
      (session.preManifestRef !== undefined && !SAFE_ID.test(session.preManifestRef)) ||
      (session.postManifestRef !== undefined && !SAFE_ID.test(session.postManifestRef))) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, `Session ${expectedId} failed strict validation.`)
  }
}

export function listWorkspaceSessions(options: WorkspaceSessionOptions): Session[] {
  const identity = roots(options)
  let names: string[]
  try {
    names = readdirSync(sessionsDir(identity.stateRoot, identity.workspaceId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Sessions directory cannot be enumerated.', { cause: error })
  }
  const sessions: Session[] = []
  for (const name of names) {
    if (name.endsWith('.journal.json')) continue
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!SAFE_ID.test(id)) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, `Session filename is not a safe identifier: ${name}`)
    }
    const session = loadSession(identity.stateRoot, identity.workspaceId, id)
    validateSession(session, id, identity.workspaceId)
    sessions.push(session)
  }
  return sessions.sort((left, right) => {
    const byTime = Date.parse(right.startedAt) - Date.parse(left.startedAt)
    return byTime === 0 ? left.id.localeCompare(right.id) : byTime
  })
}

function validateManifestBinding(manifest: Manifest, session: Session, reference: string): void {
  if (manifest.id !== reference || manifest.workspaceId !== session.workspaceId || manifest.sessionId !== session.id ||
      manifest.protectionPolicy.maxFileSizeBytes !== manifest.maxFileSizeBytes) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Manifest is not bound to the inspected Session.')
  }
}

export function inspectSession(options: WorkspaceSessionOptions & { sessionId?: string }): InspectedSession {
  const identity = roots(options)
  const sessions = listWorkspaceSessions(options)
  const selected = options.sessionId === undefined
    ? sessions[0]
    : sessions.find((session) => session.id === options.sessionId)
  if (!selected) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Requested Session does not exist.')
  }
  const pre = selected.preManifestRef
    ? loadManifest(identity.stateRoot, identity.workspaceId, selected.preManifestRef)
    : undefined
  const post = selected.postManifestRef
    ? loadManifest(identity.stateRoot, identity.workspaceId, selected.postManifestRef)
    : undefined
  if (pre) validateManifestBinding(pre, selected, selected.preManifestRef!)
  if (post) validateManifestBinding(post, selected, selected.postManifestRef!)
  if (pre && post) {
    validateRestorePlanInputs({
      root: identity.workspaceRoot,
      workspaceId: identity.workspaceId,
      sessionId: selected.id,
      pre,
      post,
      changeSet: compareManifests(pre, post),
      cas: {} as CasStore,
    })
  }
  return {
    session: selected,
    ...(pre ? { pre } : {}),
    ...(post ? { post } : {}),
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function unlockWorkspace(options: WorkspaceSessionOptions & { sessionId: string }): void {
  const identity = roots(options)
  if (!SAFE_ID.test(options.sessionId)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Unlock Session id is not safe.')
  }
  const state = readLock(identity.stateRoot, identity.workspaceId)
  if (state.state !== 'readable') {
    throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Workspace lock is absent or unreadable; ownership cannot be proven.')
  }
  const lock = state.content
  const latest = listWorkspaceSessions(options)[0]
  if (lock.workspaceId !== identity.workspaceId || lock.sessionId !== options.sessionId ||
      latest?.id !== options.sessionId || lock.hostname !== os.hostname() || processAlive(lock.pid)) {
    throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Workspace lock is not the named dead Session on this host.')
  }
  const current = readLock(identity.stateRoot, identity.workspaceId)
  if (current.state !== 'readable' || JSON.stringify(current.content) !== JSON.stringify(lock)) {
    throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Workspace lock changed during unlock verification.')
  }
  unlinkSync(path.join(identity.stateRoot, 'locks', `${identity.workspaceId}.lock`))
}

function sameJournal(left: RestoreJournal | undefined, right: RestoreJournal): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function eligibleAcceptanceJournal(journal: RestoreJournal): boolean {
  const receipts = journal.completedReceipts ?? []
  return (journal.status === 'completed' && journal.plan.scope !== undefined) ||
    (journal.status === 'prepared' && journal.attempts.length === 0 && receipts.length === 0)
}

function samePhysicalPath(left: string | undefined, right: string): boolean {
  if (!left) return false
  const a = realpathSync.native(left)
  const b = realpathSync.native(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function validateAcceptanceJournalBinding(
  identity: ReturnType<typeof roots>,
  session: Session,
  journal: RestoreJournal,
): void {
  const inspected = inspectSession({
    workspaceRoot: identity.workspaceRoot,
    stateRoot: identity.stateRoot,
    sessionId: session.id,
  })
  if (!inspected.pre || !inspected.post ||
      journal.plan.preManifestRef !== session.preManifestRef ||
      journal.plan.postManifestRef !== session.postManifestRef ||
      journal.plan.policyDigest !== policyDigest(inspected.pre.protectionPolicy) ||
      journal.plan.policyDigest !== policyDigest(inspected.post.protectionPolicy) ||
      !samePhysicalPath(journal.plan.workspaceRootReal, identity.workspaceRoot) ||
      !samePhysicalPath(journal.plan.stateRootReal, identity.stateRoot)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Acceptance Journal is not fully bound to the current Session, Manifests, policy, and roots.')
  }
}

export function acceptSession(options: WorkspaceSessionOptions & { sessionId: string }): Session {
  const identity = roots(options)
  if (!SAFE_ID.test(options.sessionId)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Accept Session id is not safe.')
  }
  const latest = listWorkspaceSessions(options)[0]
  if (!latest || latest.id !== options.sessionId) {
    throw new AgentCommitError(ErrorCodes.Conflict, 'Only the latest Session in this workspace can be accepted.')
  }
  const held = acquireLock(identity.stateRoot, {
    workspaceId: identity.workspaceId,
    sessionId: options.sessionId,
    agentCommand: '(accept)',
  })
  try {
    const lockedSessions = listWorkspaceSessions(options)
    const lockedLatest = lockedSessions[0]
    if (lockedLatest && lockedSessions[1] &&
        Date.parse(lockedLatest.startedAt) === Date.parse(lockedSessions[1].startedAt)) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Latest Session timestamp is tied; acceptance selection is ambiguous.')
    }
    if (!lockedLatest || lockedLatest.id !== options.sessionId) {
      throw new AgentCommitError(ErrorCodes.Conflict, 'Latest Session changed before acceptance acquired the workspace lock.')
    }
    const session = loadSession(identity.stateRoot, identity.workspaceId, options.sessionId)
    validateSession(session, options.sessionId, identity.workspaceId)
    const journal = loadRestoreJournal(identity.stateRoot, identity.workspaceId, options.sessionId)
    if (session.status === SessionStatus.Committed && journal === undefined) return session
    const resumableCommit = session.status === SessionStatus.Committed && journal !== undefined && eligibleAcceptanceJournal(journal)
    if (session.status !== SessionStatus.Review && !resumableCommit) {
      throw new AgentCommitError(ErrorCodes.Conflict, `Session ${session.id} cannot be accepted from ${session.status}.`)
    }
    if (journal && !eligibleAcceptanceJournal(journal)) {
      throw new AgentCommitError(ErrorCodes.Conflict, 'Session Restore Journal contains execution evidence or cannot be safely accepted.')
    }
    if (journal) validateAcceptanceJournalBinding(identity, session, journal)
    const admission = sessionAdmission(identity.stateRoot, identity.workspaceId, { excludeSessionId: session.id })
    const ownEligibleJournalBlocker = `${session.id} (unfinished restore journal)`
    const otherBlockers = admission.blockers.filter((blocker) =>
      !(journal && eligibleAcceptanceJournal(journal) && blocker === ownEligibleJournalBlocker))
    if (otherBlockers.length > 0) {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, `Workspace has another unfinished transaction: ${otherBlockers.join('; ')}`)
    }
    if (journal) {
      if (journal.workspaceId !== identity.workspaceId || journal.sessionId !== session.id) {
        throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Completed scoped Journal is not bound to the Session.')
      }
      archiveRestoreJournal(identity.stateRoot, journal)
      const archived = JSON.parse(readFileSync(
        archivedRestoreJournalPath(identity.stateRoot, identity.workspaceId, session.id, journal.plan.planId),
        'utf8',
      )) as RestoreJournal
      if (JSON.stringify(archived) !== JSON.stringify(journal)) {
        throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Archived scoped Journal differs from the active Journal.')
      }
      const activeBytes = readFileSync(restoreJournalPath(identity.stateRoot, identity.workspaceId, session.id))
      const archivedBytes = readFileSync(archivedRestoreJournalPath(identity.stateRoot, identity.workspaceId, session.id, journal.plan.planId))
      if (!activeBytes.equals(archivedBytes)) {
        throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Archived scoped Journal bytes differ from the active Journal.')
      }
    }
    const committed: Session = session.status === SessionStatus.Committed ? session : {
      ...session,
      status: SessionStatus.Committed,
      endedAt: new Date().toISOString(),
    }
    persistSession(identity.stateRoot, identity.workspaceId, committed)
    if (journal) {
      const active = loadRestoreJournal(identity.stateRoot, identity.workspaceId, session.id)
      if (!sameJournal(active, journal)) {
        throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Active scoped Journal changed during acceptance.')
      }
      const activePath = restoreJournalPath(identity.stateRoot, identity.workspaceId, session.id)
      if (!lstatSync(activePath).isFile()) {
        throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Active scoped Journal is not a regular file.')
      }
      unlinkSync(activePath)
    }
    return committed
  } finally {
    const current = readLock(identity.stateRoot, identity.workspaceId)
    if (current.state !== 'readable' || JSON.stringify(current.content) !== JSON.stringify(held)) {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Accept lock ownership changed; refusing to release it by Session id alone.')
    }
    if (!releaseLock(identity.stateRoot, identity.workspaceId, options.sessionId)) {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Accept lock could not be released.')
    }
  }
}
