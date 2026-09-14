import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { FSCasStore } from '../cas/fs-cas.js'
import { compareManifests } from '../diff/changeset.js'
import { ChangeAssessments, ChangeKinds, type Change } from '../diff/types.js'
import { SessionStatus, type Session } from '../session/types.js'
import { loadManifest } from '../snapshot/manifest.js'
import type { FileRecord, Manifest } from '../snapshot/types.js'
import { policyDigest } from '../snapshot/policy.js'
import { resolveWorkspace } from '../storage/discovery.js'
import { acquireLock, readLock, releaseLock } from '../storage/lock.js'
import { resolveStateRoot, sessionsDir } from '../storage/paths.js'
import { loadSession, persistSession } from '../storage/session-store.js'
import { readdirSync } from 'node:fs'
import { buildRestorePlan, loadRestorePlan, restorePlanDigest, saveRestorePlan, validateRestorePlanInputs } from './plan.js'
import { observationPathProblem } from './path-safety.js'
import {
  archiveRestoreJournal,
  loadRestoreJournal,
  persistRestoreJournal,
} from './journal.js'
import type {
  Conflict,
  RestoreAction,
  RestoreExecutionHooks,
  RestoreExecutionResult,
  RestoreForceAuthorization,
  RestoreHookContext,
  RestoreHookPoint,
  RestoreJournal,
  RestoreJournalAction,
  RestorePlan,
} from './types.js'

const CHUNK = 64 << 10
const activeExecutors = new Set<string>()

export interface PrepareRestoreOptions {
  workspaceRoot: string
  stateRoot?: string
  scope?: string
}

export interface ExecuteRestoreOptions {
  workspaceRoot: string
  stateRoot?: string
  plan: RestorePlan
  forceAuthorization?: RestoreForceAuthorization
  hooks?: RestoreExecutionHooks
}

function canonicalExistingRoot(input: string): string {
  return realpathSync.native(path.resolve(input))
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function roots(options: { workspaceRoot: string; stateRoot?: string }): {
  workspaceRoot: string
  stateRoot: string
  workspaceId: string
  rootDev: number
  rootIno: number
} {
  const requestedPath = path.resolve(options.workspaceRoot)
  const requestedStat = lstatSync(requestedPath)
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore workspaceRoot must be a real directory, not a link.')
  }
  const resolved = resolveWorkspace(options.workspaceRoot)
  const workspaceRoot = canonicalExistingRoot(resolved.root)
  const requestedRoot = canonicalExistingRoot(options.workspaceRoot)
  if (!samePath(workspaceRoot, requestedRoot)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore must be invoked with the exact workspace root.')
  }
  const stateRoot = canonicalExistingRoot(options.stateRoot ?? resolveStateRoot())
  if (isWithin(workspaceRoot, stateRoot)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'AgentCommit stateRoot must be outside the restore target.')
  }
  const rootStat = lstatSync(workspaceRoot)
  return {
    workspaceRoot,
    stateRoot,
    workspaceId: resolved.config.workspaceId,
    rootDev: rootStat.dev,
    rootIno: rootStat.ino,
  }
}

function assertRootIdentity(identity: ReturnType<typeof roots>): void {
  let stat
  try { stat = lstatSync(identity.workspaceRoot) } catch (error) {
    throw new AgentCommitError(ErrorCodes.Conflict, 'Restore workspaceRoot disappeared or became inaccessible.', { cause: error })
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.rootDev || stat.ino !== identity.rootIno) {
    throw new AgentCommitError(ErrorCodes.Conflict, 'Restore workspaceRoot identity changed during execution.')
  }
  let currentReal: string
  try { currentReal = realpathSync.native(identity.workspaceRoot) } catch (error) {
    throw new AgentCommitError(ErrorCodes.Conflict, 'Restore workspaceRoot real path cannot be verified.', { cause: error })
  }
  if (!samePath(currentReal, identity.workspaceRoot)) {
    throw new AgentCommitError(ErrorCodes.Conflict, 'Restore workspaceRoot real path changed during execution.')
  }
}

function listSessions(stateRoot: string, workspaceId: string): Session[] {
  let names: string[]
  try {
    names = readdirSync(sessionsDir(stateRoot, workspaceId))
  } catch (error) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Sessions directory is unreadable.', { cause: error })
  }
  const sessions = names.filter((name) => name.endsWith('.json') && !name.endsWith('.journal.json')).map((name) => {
    const id = name.slice(0, -5)
    const session = loadSession(stateRoot, workspaceId, id)
    if (session.id !== id || session.workspaceId !== workspaceId ||
        !Object.values(SessionStatus).includes(session.status) ||
        !Number.isFinite(Date.parse(session.startedAt))) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, `Session ${id} has invalid identity/timestamp.`)
    }
    return session
  })
  if (sessions.length === 0) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'No session exists for restore.')
  sessions.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  if (sessions[1] && Date.parse(sessions[0]!.startedAt) === Date.parse(sessions[1].startedAt)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Latest session timestamp is tied; refusing ambiguous restore selection.')
  }
  return sessions
}

function latestRecoverable(stateRoot: string, workspaceId: string): { session: Session; journal?: RestoreJournal } {
  const session = listSessions(stateRoot, workspaceId)[0]!
  for (const name of readdirSync(sessionsDir(stateRoot, workspaceId)).filter((entry) => entry.endsWith('.journal.json'))) {
    const journalSessionId = name.slice(0, -'.journal.json'.length)
    const candidate = loadRestoreJournal(stateRoot, workspaceId, journalSessionId)
    if (candidate && journalSessionId !== session.id &&
        (candidate.status !== 'completed' || candidate.plan.scope !== undefined)) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, `Older session ${journalSessionId} has unfinished restore state; latest-session recovery is ambiguous.`)
    }
  }
  const journal = loadRestoreJournal(stateRoot, workspaceId, session.id)
  const unfinished = journal !== undefined && journal.status !== 'completed'
  if (session.status === SessionStatus.RollbackFailed && !journal) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, `Rollback-failed session ${session.id} lacks its Restore Journal.`)
  }
  const allowed = session.status === SessionStatus.Review ||
    session.status === SessionStatus.RollbackFailed ||
    (session.status === SessionStatus.Failed && unfinished)
  if (!allowed) {
    throw new AgentCommitError(ErrorCodes.Conflict, `Latest session ${session.id} is not recoverable (${session.status}).`)
  }
  return journal ? { session, journal } : { session }
}

function loadBoundManifests(stateRoot: string, workspaceId: string, session: Session): { pre: Manifest; post: Manifest } {
  if (!session.preManifestRef || !session.postManifestRef) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Recoverable session lacks Pre/Post manifest references.')
  }
  const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
  if (!safeId.test(session.preManifestRef) || !safeId.test(session.postManifestRef)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Session Manifest reference is not a safe state identifier.')
  }
  const pre = loadManifest(stateRoot, workspaceId, session.preManifestRef)
  const post = loadManifest(stateRoot, workspaceId, session.postManifestRef)
  if (pre.id !== session.preManifestRef || post.id !== session.postManifestRef ||
      pre.workspaceId !== workspaceId || post.workspaceId !== workspaceId ||
      pre.sessionId !== session.id || post.sessionId !== session.id) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Pre/Post manifests are not bound to the latest session.')
  }
  return { pre, post }
}

function modeOf(record: FileRecord | undefined): number | undefined {
  return process.platform === 'win32' || record?.mode === undefined ? undefined : record.mode & 0o777
}

function actionFor(change: Change, preRecord: FileRecord | undefined, index: number): RestoreAction | undefined {
  if (change.assessment === ChangeAssessments.CapabilityGap || change.kind === ChangeKinds.TypeChanged) return undefined
  const common = { id: `action-${String(index + 1).padStart(3, '0')}`, path: change.path, order: index }
  if (change.kind === ChangeKinds.Created) {
    return { ...common, type: 'delete-path', expectedCurrent: 'matches-post' }
  }
  if (change.kind === ChangeKinds.MetadataOnly && preRecord?.type === 'file' && modeOf(preRecord) !== undefined) {
    return { ...common, type: 'restore-metadata', mode: modeOf(preRecord), expectedCurrent: 'matches-post' }
  }
  if ((change.kind === ChangeKinds.Modified || change.kind === ChangeKinds.Deleted) && preRecord?.type === 'file' && preRecord.hash) {
    return {
      ...common,
      type: 'write-file',
      blobHash: preRecord.hash,
      ...(modeOf(preRecord) !== undefined ? { mode: modeOf(preRecord) } : {}),
      expectedCurrent: change.kind === ChangeKinds.Deleted ? 'absent' : 'matches-post',
    }
  }
  if ((change.kind === ChangeKinds.Modified || change.kind === ChangeKinds.Deleted) &&
      (preRecord?.type === 'symlink' || preRecord?.type === 'junction') && preRecord.symlinkTarget) {
    return {
      ...common,
      type: 'restore-symlink',
      target: preRecord.symlinkTarget,
      expectedCurrent: change.kind === ChangeKinds.Deleted ? 'absent' : 'matches-post',
    }
  }
  return undefined
}

function fpToken(fp: string, index: number): string | undefined {
  const parts = fp.split(':')
  return parts.length > index ? parts[index] : undefined
}

/** Mode-tolerant fingerprint equality: content must match; the mode segment is
 *  compared only when BOTH sides carry one (legacy '-'-only fingerprints never
 *  false-conflict; real mode drift is handled by explicit checks). */
function contentMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (actual === undefined || expected === undefined) return actual === expected
  if (actual === expected) return true
  if (!actual.startsWith('file:') || !expected.startsWith('file:')) return false
  if (fpToken(actual, 1) !== fpToken(expected, 1)) return false
  const am = fpToken(actual, 2)
  const bm = fpToken(expected, 2)
  // '-' is the "no mode evidence" sentinel (legacy manifests): it never counts
  // as a mismatch, exactly like an absent token.
  if (am === undefined || bm === undefined || am === '-' || bm === '-') return true
  return am === bm
}

function fingerprintForRecord(record: FileRecord | undefined): string {
  if (!record) return 'absent'
  if (record.type === 'file' && record.hash) return `file:${record.hash}:${modeOf(record) ?? '-'}`
  if ((record.type === 'symlink' || record.type === 'junction') && record.symlinkTarget !== undefined) {
    return `symlink:${JSON.stringify(record.symlinkTarget)}`
  }
  return `unsupported:${record.type}`
}

/** Stable, public force-binding fingerprint. Links are observed as link entries. */
export function observeRestoreFingerprint(root: string, rel: string): string {
  const problem = observationPathProblem(root, rel)
  if (problem) return `unknown:${problem}`
  const target = path.join(root, rel)
  try {
    const st = lstatSync(target)
    if (st.isSymbolicLink()) return `symlink:${JSON.stringify(readlinkSync(target))}`
    if (st.isDirectory()) return 'directory'
    if (!st.isFile()) return 'other'
    const hash = createHash('sha256')
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const fd = openSync(target, constants.O_RDONLY | noFollow)
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) return 'unknown:identity-changed'
      const buffer = Buffer.allocUnsafe(CHUNK)
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null)
        if (count === 0) break
        hash.update(buffer.subarray(0, count))
      }
      const finished = fstatSync(fd)
      if (finished.dev !== opened.dev || finished.ino !== opened.ino ||
          finished.size !== opened.size || finished.mtimeMs !== opened.mtimeMs) return 'unknown:changed-during-read'
      // The observed fingerprint carries the live POSIX rwx bits (Windows: '-',
      // since mode is never recorded there). Equality comparisons are
      // mode-tolerant through contentMatches, so legacy '-' mode fingerprints
      // never mismatch a real mode on the filesystem.
      const mode = process.platform === 'win32' ? '-' : String(finished.mode & 0o777)
      return `file:${hash.digest('hex')}:${mode}`
    } finally { closeSync(fd) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown:inaccessible'
  }
}

function withBindings(plan: RestorePlan, workspaceRoot: string, stateRoot: string): RestorePlan {
  const { planDigest: _old, ...body } = plan
  const bound = { ...body, workspaceRootReal: workspaceRoot, stateRootReal: stateRoot }
  return { ...bound, planDigest: restorePlanDigest(bound) }
}

function completePlan(plan: RestorePlan, pre: Manifest, post: Manifest, workspaceRoot: string): RestorePlan {
  const changes = compareManifests(pre, post).entries
  const preByPath = new Map(pre.files.map((record) => [record.path, record]))
  const postByPath = new Map(post.files.map((record) => [record.path, record]))
  const selected = plan.scope
    ? changes.filter((change) => change.path === plan.scope || change.path.startsWith(plan.scope + '/'))
    : changes
  const generated: RestoreAction[] = []
  for (const change of selected) {
    const action = actionFor(change, preByPath.get(change.path), generated.length)
    if (!action) continue
    if (process.platform === 'win32' && action.type === 'restore-symlink') continue
    generated.push(action)
  }
  generated.sort((a, b) => Number(a.type === 'delete-path') - Number(b.type === 'delete-path') || a.path.localeCompare(b.path))
  generated.forEach((action, index) => { action.id = `action-${String(index + 1).padStart(3, '0')}`; action.order = index })
  const conflicts = plan.conflicts.flatMap((conflict) => {
    const currentFingerprint = observeRestoreFingerprint(workspaceRoot, conflict.path)
    // P2-A calls a Windows junction observation "symlink" while the Manifest
    // record calls it "junction". The P2-B fingerprint contract intentionally
    // normalizes both link-entry names, so an unchanged created junction is
    // safe and must not become a false conflict.
    if (currentFingerprint === fingerprintForRecord(postByPath.get(conflict.path))) return []
    return [{ ...conflict, currentFingerprint }]
  })
  const blocked = plan.blocked.filter((item) =>
    process.platform === 'win32' || !item.reason.includes('mode-only change'))
  for (const action of generated) {
    const parts = action.path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = path.join(workspaceRoot, ...parts.slice(0, index))
      try {
        const stat = lstatSync(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          blocked.push({ path: action.path, reason: 'parent directory dependency is not a real directory' })
          break
        }
      } catch (error) {
        blocked.push({
          path: action.path,
          reason: (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'missing parent directory dependency; directory recreation is unsupported'
            : 'parent directory dependency is inaccessible',
        })
        break
      }
    }
  }
  if (process.platform === 'win32') {
    for (const change of selected) {
      const rec = preByPath.get(change.path)
      if ((rec?.type === 'symlink' || rec?.type === 'junction') && change.kind !== ChangeKinds.Created) {
        blocked.push({ path: change.path, reason: 'link recreation is unsupported on Windows without a reliable link-kind/privilege contract' })
      }
    }
  }
  const { planDigest: _old, ...body } = plan
  const next = { ...body, actions: generated, conflicts, blocked }
  return { ...next, planDigest: restorePlanDigest(next) }
}

export async function prepareRestore(options: PrepareRestoreOptions): Promise<RestorePlan> {
  const identity = roots(options)
  let selected = latestRecoverable(identity.stateRoot, identity.workspaceId)
  if (selected.journal && selected.journal.status !== 'completed') {
    const persisted = selected.journal.plan
    if (!samePath(persisted.workspaceRootReal ?? '', identity.workspaceRoot) ||
        !samePath(persisted.stateRootReal ?? '', identity.stateRoot)) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Unfinished Restore Journal root binding differs from this request.')
    }
    if (options.scope !== persisted.scope) {
      throw new AgentCommitError(ErrorCodes.Conflict, 'Retry scope must exactly match the unfinished Restore Journal.')
    }
    return persisted
  }
  if (activeExecutors.has(identity.workspaceId)) {
    throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Another prepare/execute operation is active in this process.')
  }
  activeExecutors.add(identity.workspaceId)
  let locked = false
  const lockSessionId = selected.session.id
  try {
    const existingLock = readLock(identity.stateRoot, identity.workspaceId)
    if (existingLock.state === 'readable' &&
        (existingLock.content.sessionId !== selected.session.id || existingLock.content.pid === process.pid)) {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Workspace lock is already owned by another operation.')
    }
    acquireLock(identity.stateRoot, { workspaceId: identity.workspaceId, sessionId: lockSessionId, agentCommand: '(prepare-restore)' })
    locked = true
    selected = latestRecoverable(identity.stateRoot, identity.workspaceId)
    if (selected.journal && selected.journal.status !== 'completed') {
      if (options.scope !== selected.journal.plan.scope) throw new AgentCommitError(ErrorCodes.Conflict, 'Retry scope must exactly match the unfinished Restore Journal.')
      return selected.journal.plan
    }
  const { pre, post } = loadBoundManifests(identity.stateRoot, identity.workspaceId, selected.session)
  const cas = new FSCasStore(identity.stateRoot)
  const built = await buildRestorePlan({
    root: identity.workspaceRoot,
    workspaceId: identity.workspaceId,
    sessionId: selected.session.id,
    pre,
    post,
    changeSet: compareManifests(pre, post),
    cas,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
  })
  let plan = completePlan(built.plan, pre, post, identity.workspaceRoot)
  const carriedReceipts = selected.journal
    ? [
        ...(selected.journal.completedReceipts ?? []),
        ...selected.journal.attempts.flatMap((attempt) => attempt.actions
          .filter((action) => action.status === 'verified')
          .map((action) => ({ path: action.path, expectedFingerprint: action.expectedFingerprint, planId: selected.journal!.plan.planId, planDigest: selected.journal!.planDigest, attemptId: attempt.id }))),
      ]
    : []
  if (carriedReceipts.length) {
    const validPaths = new Set(carriedReceipts.filter((receipt) =>
      observeRestoreFingerprint(identity.workspaceRoot, receipt.path) === receipt.expectedFingerprint,
    ).map((receipt) => receipt.path))
    const { planDigest: _digest, ...body } = plan
    const adjusted = { ...body, conflicts: plan.conflicts.filter((conflict) => !validPaths.has(conflict.path)) }
    plan = { ...adjusted, planDigest: restorePlanDigest(adjusted) }
  }
  plan = withBindings(plan, identity.workspaceRoot, identity.stateRoot)
  saveRestorePlan(identity.stateRoot, identity.workspaceId, plan)
  if (selected.journal) archiveRestoreJournal(identity.stateRoot, selected.journal)
  persistRestoreJournal(identity.stateRoot, {
    schemaVersion: 1,
    workspaceId: identity.workspaceId,
    sessionId: selected.session.id,
    planDigest: plan.planDigest,
    plan,
    status: 'prepared',
    attempts: [],
    ...(carriedReceipts.length ? { completedReceipts: carriedReceipts } : {}),
  })
  return plan
  } finally {
    if (locked) releaseLock(identity.stateRoot, identity.workspaceId, lockSessionId)
    activeExecutors.delete(identity.workspaceId)
  }
}

function authorizedConflicts(plan: RestorePlan, authorization: RestoreForceAuthorization | undefined): Set<string> {
  if (plan.conflicts.length === 0) return new Set()
  if (!authorization || authorization.schemaVersion !== 1 || authorization.sessionId !== plan.sessionId ||
      authorization.planDigest !== plan.planDigest) return new Set()
  const granted = new Map(authorization.conflicts.map((item) => [item.path, item.currentFingerprint]))
  return new Set(plan.conflicts.filter((conflict) =>
    conflict.currentFingerprint !== undefined && granted.get(conflict.path) === conflict.currentFingerprint,
  ).map((conflict) => conflict.path))
}

function expectedActions(pre: Manifest, post: Manifest, plan: RestorePlan): RestoreAction[] {
  const preByPath = new Map(pre.files.map((record) => [record.path, record]))
  const changes = compareManifests(pre, post).entries.filter((change) =>
    !plan.scope || change.path === plan.scope || change.path.startsWith(plan.scope + '/'))
  const expected: RestoreAction[] = []
  for (const change of changes) {
    const action = actionFor(change, preByPath.get(change.path), expected.length)
    if (action && !(process.platform === 'win32' && action.type === 'restore-symlink')) expected.push(action)
  }
  expected.sort((a, b) => Number(a.type === 'delete-path') - Number(b.type === 'delete-path') || a.path.localeCompare(b.path))
  expected.forEach((action, index) => { action.id = `action-${String(index + 1).padStart(3, '0')}`; action.order = index })
  return expected
}

function validateActionDerivation(plan: RestorePlan, pre: Manifest, post: Manifest): void {
  const prePolicy = policyDigest(pre.protectionPolicy)
  if (plan.preManifestRef !== pre.id || plan.postManifestRef !== post.id ||
      plan.policyDigest !== prePolicy || policyDigest(post.protectionPolicy) !== prePolicy) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'RestorePlan Pre/Post/policy binding is invalid.')
  }
  const expected = expectedActions(pre, post, plan)
  if (JSON.stringify(expected) !== JSON.stringify(plan.actions)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'RestorePlan actions do not match persisted Pre/Post manifests.')
  }
}

async function hook(hooks: RestoreExecutionHooks | undefined, point: RestoreHookPoint, context: RestoreHookContext): Promise<void> {
  const snapshot = Object.freeze({ ...context, action: Object.freeze({ ...context.action }) })
  await hooks?.[point]?.(snapshot)
}

async function saveJournal(
  stateRoot: string,
  journal: RestoreJournal,
  hooks: RestoreExecutionHooks | undefined,
  context: RestoreHookContext,
): Promise<RestoreJournal> {
  await hook(hooks, 'before-journal-write', context)
  return persistRestoreJournal(stateRoot, journal)
}

function previousAction(journal: RestoreJournal, actionId: string): RestoreJournalAction | undefined {
  for (let i = journal.attempts.length - 1; i >= 0; i--) {
    const found = journal.attempts[i]!.actions.find((action) => action.actionId === actionId)
    if (found) return found
  }
  return undefined
}

function receiptFor(journal: RestoreJournal, path: string): { path: string; expectedFingerprint: string; planId: string; planDigest: string; attemptId: string } | undefined {
  return journal.completedReceipts?.find((receipt) => receipt.path === path)
}

function validateCompletedJournal(plan: RestorePlan, journal: RestoreJournal, pre: Manifest): void {
  if (journal.status !== 'completed') return
  const preByPath = new Map(pre.files.map((record) => [record.path, record]))
  for (const action of plan.actions) {
    const expected = fingerprintForRecord(preByPath.get(action.path))
    const receipt = receiptFor(journal, action.path)
    const verified = previousAction(journal, action.id)
    if (receipt?.expectedFingerprint === expected) continue
    if (verified?.status === 'verified' && verified.expectedFingerprint === expected) continue
    throw new AgentCommitError(ErrorCodes.StateCorrupt, `Completed Restore Journal lacks verified coverage for ${action.path}.`)
  }
}

async function finalizeCompletedRestore(
  identity: ReturnType<typeof roots>,
  plan: RestorePlan,
  session: Session,
  journal: RestoreJournal,
  pre: Manifest,
  cas: FSCasStore,
  hooks: RestoreExecutionHooks | undefined,
  onDurable: () => void,
  attemptId?: string,
): Promise<RestoreJournal> {
  const persisted = persistRestoreJournal(identity.stateRoot, { ...journal, status: 'completed' })
  const reloaded = loadRestoreJournal(identity.stateRoot, identity.workspaceId, plan.sessionId)
  if (!reloaded || JSON.stringify(reloaded) !== JSON.stringify(persisted)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Completed Restore Journal could not be verified after persistence.')
  }
  validateCompletedJournal(plan, reloaded, pre)
  onDurable()
  const hookAction = plan.actions[0]
  if (hookAction) {
    await hook(hooks, 'after-journal-completed', {
      action: hookAction,
      attemptId: attemptId ?? reloaded.attempts.at(-1)?.id ?? `finalize-${plan.planId}`,
    })
  }
  for (const action of plan.actions) {
    if (action.blobHash && !(await cas.verify(action.blobHash))) {
      throw new AgentCommitError(ErrorCodes.BlobCorrupt, `CAS finalization verification failed: ${action.blobHash}`)
    }
  }
  assertRootIdentity(identity)
  const finalJournal = loadRestoreJournal(identity.stateRoot, identity.workspaceId, plan.sessionId)
  if (!finalJournal || JSON.stringify(finalJournal) !== JSON.stringify(reloaded)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Completed Restore Journal changed during finalization.')
  }
  validateCompletedJournal(plan, finalJournal, pre)
  const preByPath = new Map(pre.files.map((record) => [record.path, record]))
  for (const action of plan.actions) {
    assertRootIdentity(identity)
    const expected = fingerprintForRecord(preByPath.get(action.path))
    if (observeRestoreFingerprint(identity.workspaceRoot, action.path) !== expected) {
      throw new AgentCommitError(ErrorCodes.Conflict, `${action.path}: finalization verification drifted from Pre.`)
    }
  }
  const { endedAt: _endedAt, ...sessionWithoutEnd } = session
  persistSession(identity.stateRoot, identity.workspaceId, {
    ...(plan.scope === undefined ? session : sessionWithoutEnd),
    status: plan.scope === undefined ? SessionStatus.RolledBack : SessionStatus.Review,
    ...(plan.scope === undefined ? { endedAt: new Date().toISOString() } : {}),
  })
  return finalJournal
}

function preflight(
  identity: ReturnType<typeof roots>,
  plan: RestorePlan,
  journal: RestoreJournal,
  pre: Manifest,
  post: Manifest,
  force: RestoreForceAuthorization | undefined,
): Conflict[] {
  if (!samePath(plan.workspaceRootReal ?? '', identity.workspaceRoot) || !samePath(plan.stateRootReal ?? '', identity.stateRoot) ||
      plan.workspaceId !== identity.workspaceId || journal.planDigest !== plan.planDigest) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore root/workspace/Journal binding mismatch.')
  }
  const persisted = loadRestorePlan(identity.stateRoot, identity.workspaceId, plan.planId)
  if (persisted.planDigest !== plan.planDigest || JSON.stringify(persisted) !== JSON.stringify(plan) ||
      JSON.stringify(journal.plan) !== JSON.stringify(plan)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'ExecuteRestore plan differs from the persisted immutable plan.')
  }
  validateActionDerivation(plan, pre, post)
  if (plan.blocked.length > 0 || !plan.verifiedBlobs) {
    throw new AgentCommitError(ErrorCodes.UnsupportedFile, 'RestorePlan contains blocked or unverified items.')
  }
  // R2 defense for resumed Journals: a plan persisted by an older build may
  // contain actions whose Pre/Post records lack the rwx evidence its guards
  // need (plan-level evidence gates did not exist when it was prepared). These
  // gates refuse BEFORE any new target write and describe precisely what
  // earlier attempts already did, so a permanent evidence gap is never
  // mistaken for a retryable failure and never silently retried.
  if (process.platform !== 'win32') {
    const evidencePre = new Map(pre.files.map((record) => [record.path, record]))
    const evidencePost = new Map(post.files.map((record) => [record.path, record]))
    // Two different claims must not be conflated: (a) this refusal is decided in
    // preflight, so THIS call performs no restore writes; (b) what EARLIER
    // attempts did is only ever described as Journal history. A pending intent
    // means the action may already have taken effect on disk; a verified entry
    // is not re-checked against Current here, so neither state is claimed for
    // the present filesystem.
    const verifiedPaths = [...new Set([
      ...(journal.completedReceipts ?? []).map((receipt) => receipt.path),
      ...journal.attempts.flatMap((attempt) => attempt.actions
        .filter((entry) => entry.status === 'verified').map((entry) => entry.path)),
    ])].sort()
    const intentPaths = [...new Set(journal.attempts.flatMap((attempt) => attempt.actions
      .filter((entry) => entry.status === 'intent').map((entry) => entry.path)))].sort()
    let describeAlready = '; this refusal is a preflight decision — this call performs no restore writes'
    if (verifiedPaths.length) {
      describeAlready += `; the Journal records ${verifiedPaths.length} verified restore(s) from earlier attempts (${verifiedPaths.join(', ')}) — historical record, not re-checked against Current`
    }
    if (intentPaths.length) {
      describeAlready += `; ${intentPaths.length} path(s) carry unfinished intents from earlier attempts (${intentPaths.join(', ')}) — those actions may have already taken effect`
    }
    if (!verifiedPaths.length && !intentPaths.length) {
      describeAlready += '; the Journal records no verified restore and no pending intent from earlier attempts'
    }
    for (const action of plan.actions) {
      const actionPre = evidencePre.get(action.path)
      const actionPost = evidencePost.get(action.path)
      const needsPost = action.type === 'write-file' || action.type === 'restore-metadata' || action.type === 'delete-path'
      const needsPre = action.type === 'write-file' || action.type === 'restore-metadata'
      if (needsPre && actionPre?.type === 'file' && actionPre.mode === undefined) {
        throw new AgentCommitError(ErrorCodes.UnsupportedFile,
          `${action.path}: the persisted Pre record has no rwx evidence for this regular file on POSIX; this restore cannot continue safely${describeAlready}`)
      }
      if (needsPost && actionPost?.type === 'file' && actionPost.mode === undefined) {
        throw new AgentCommitError(ErrorCodes.UnsupportedFile,
          `${action.path}: the persisted Post record has no rwx evidence for this regular file on POSIX; this restore cannot continue safely${describeAlready}`)
      }
    }
  }
  const grants = authorizedConflicts(plan, force)
  const ungranted = plan.conflicts.filter((conflict) => !grants.has(conflict.path))
  if (ungranted.length) return ungranted
  const preByPath = new Map(pre.files.map((record) => [record.path, record]))
  const postByPath = new Map(post.files.map((record) => [record.path, record]))
  const conflicts: Conflict[] = []
  for (const action of plan.actions) {
    assertRootIdentity(identity)
    const problem = observationPathProblem(identity.workspaceRoot, action.path)
    if (problem) throw new AgentCommitError(ErrorCodes.StateCorrupt, `Unsafe restore path ${action.path}: ${problem}`)
    const parent = path.dirname(path.join(identity.workspaceRoot, action.path))
    try {
      if (!lstatSync(parent).isDirectory()) throw new Error('not-directory')
    } catch {
      throw new AgentCommitError(ErrorCodes.UnsupportedFile, `${action.path}: parent directory is missing or unsafe.`)
    }
    const current = observeRestoreFingerprint(identity.workspaceRoot, action.path)
    if (current.startsWith('unknown:') || current === 'directory' || current === 'other') {
      throw new AgentCommitError(ErrorCodes.UnsupportedFile, `${action.path}: Current type/state is not safely restorable.`)
    }
    const prior = previousAction(journal, action.id)
    const receipt = receiptFor(journal, action.path)
    const preFingerprint = fingerprintForRecord(preByPath.get(action.path))
    const postFingerprint = fingerprintForRecord(postByPath.get(action.path))
    if (receipt) {
      if (contentMatches(current, preFingerprint) && contentMatches(current, receipt.expectedFingerprint)) continue
      conflicts.push({ path: action.path, kind: 'user-modified-after-session', currentFingerprint: current, message: 'Previously completed scoped restore path drifted from Pre; force cannot reopen a verified receipt.' })
      continue
    }
    if (prior?.status === 'verified') {
      if (!contentMatches(current, preFingerprint)) conflicts.push({ path: action.path, kind: 'user-modified-after-session', currentFingerprint: current, message: 'Previously verified restore path drifted from Pre.' })
      continue
    }
    if (prior?.status === 'intent') {
      if (!contentMatches(current, preFingerprint) && !contentMatches(current, prior.beforeFingerprint)) {
        conflicts.push({ path: action.path, kind: 'user-modified-after-session', currentFingerprint: current, message: 'Interrupted action Current matches neither Pre nor recorded before-state.' })
      }
      continue
    }
    // OQ-07 (POSIX only): a chmod between planning and execution is drift. The
    // post record carries the expected rwx bits when they were tracked.
    const modePost = postByPath.get(action.path)?.mode
    if (modePost !== undefined && process.platform !== 'win32' &&
        (action.type === 'write-file' || action.type === 'restore-metadata')) {
      const stNow = (() => { try { return lstatSync(path.join(identity.workspaceRoot, action.path)) } catch { return undefined } })()
      if (stNow && stNow.isFile() && (stNow.mode & 0o777) !== (modePost & 0o777) && !receipt && !prior) {
        conflicts.push({ path: action.path, kind: 'user-modified-after-session', currentFingerprint: current, message: 'Current rwx bits changed after the restore was planned (mode drift); refusing rather than silently chmodding.' })
        continue
      }
    }
    if (grants.has(action.path)) {
      const planned = plan.conflicts.find((conflict) => conflict.path === action.path)
      if (planned?.currentFingerprint !== current) conflicts.push({ ...planned!, currentFingerprint: current, message: 'Current changed after force authorization was prepared.' })
    } else if (!contentMatches(current, postFingerprint)) {
      conflicts.push({ path: action.path, kind: 'user-modified-after-session', currentFingerprint: current, message: 'Current no longer matches persisted Post.' })
    }
  }
  return conflicts
}

function writeFileAction(identity: ReturnType<typeof roots>, action: RestoreAction, bytes: Uint8Array, context: RestoreHookContext, hooks?: RestoreExecutionHooks): Promise<void> {
  return (async () => {
    const root = identity.workspaceRoot
    const target = path.join(root, action.path)
    const temp = context.tempPath
    if (!temp) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'write-file intent lacks its owned temp path.')
    let replaced = false
    let created = false
    let tempIdentity: { dev: number; ino: number } | undefined
    try {
      assertRootIdentity(identity)
      if (observationPathProblem(root, action.path)) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore parent changed before temp creation.')
      if (!contentMatches(observeRestoreFingerprint(root, action.path), context.beforeFingerprint)) throw new AgentCommitError(ErrorCodes.Conflict, 'Current changed before temp creation.')
      // R3: the temp file must be created with conservative permissions
      // (0600) so a sensitive restore never exposes wider bytes before the
      // final chmod to the recorded Pre mode. umask is not relied on.
      const fd = openSync(temp, 'wx+', 0o600)
      created = true
      try {
      const opened = fstatSync(fd)
      tempIdentity = { dev: opened.dev, ino: opened.ino }
      let offset = 0
      while (offset < bytes.length) {
        const end = Math.min(offset + CHUNK, bytes.length)
        const chunk = bytes.subarray(offset, end)
        let written = 0
        while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written)
        offset = end
        await hook(hooks, 'temp-write', context)
      }
      if (process.platform !== 'win32' && action.mode !== undefined) {
        fchmodSync(fd, action.mode & 0o777)
        if ((fstatSync(fd).mode & 0o777) !== (action.mode & 0o777)) throw new Error('mode verification failed')
      }
        fsyncSync(fd)
        const hash = createHash('sha256')
        const readBuffer = Buffer.allocUnsafe(CHUNK)
        let readOffset = 0
        for (;;) {
          const count = readSync(fd, readBuffer, 0, readBuffer.length, readOffset)
          if (count === 0) break
          hash.update(readBuffer.subarray(0, count))
          readOffset += count
        }
        if (hash.digest('hex') !== action.blobHash) throw new AgentCommitError(ErrorCodes.BlobCorrupt, 'Read-back temp content hash differs from the requested CAS blob.')
      } finally { closeSync(fd) }
      await hook(hooks, 'before-action', context)
      assertRootIdentity(identity)
      if (observationPathProblem(root, action.path)) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore parent changed before replace.')
      if (observeRestoreFingerprint(root, action.path) !== context.beforeFingerprint) throw new AgentCommitError(ErrorCodes.Conflict, 'Current changed at the final replace guard.')
      renameSync(temp, target)
      replaced = true
      await hook(hooks, 'after-replace', context)
    } finally {
      if (!replaced && created && tempIdentity) {
        try {
          const current = lstatSync(temp)
          if (current.isFile() && current.dev === tempIdentity.dev && current.ino === tempIdentity.ino) unlinkSync(temp)
        } catch { /* preserve the original failure; never remove an unverified replacement */ }
      }
    }
  })()
}

async function performAction(identity: ReturnType<typeof roots>, action: RestoreAction, cas: FSCasStore, context: RestoreHookContext, hooks?: RestoreExecutionHooks): Promise<void> {
  const root = identity.workspaceRoot
  if (action.type === 'write-file') {
    if (!action.blobHash) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'write-file action lacks blobHash.')
    await writeFileAction(identity, action, await cas.get(action.blobHash), context, hooks)
    return
  }
  await hook(hooks, 'before-action', context)
  assertRootIdentity(identity)
  if (observationPathProblem(root, action.path)) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore parent changed at final action guard.')
  if (!contentMatches(observeRestoreFingerprint(root, action.path), context.beforeFingerprint)) throw new AgentCommitError(ErrorCodes.Conflict, 'Current changed at the final action guard.')
  const target = path.join(root, action.path)
  if (action.type === 'delete-path') {
    unlinkSync(target)
    await hook(hooks, 'after-delete', context)
    return
  }
  if (action.type === 'restore-metadata') {
    if (process.platform === 'win32' || action.mode === undefined) throw new AgentCommitError(ErrorCodes.UnsupportedFile, 'File mode restore unsupported on this platform.')
    const before = lstatSync(target)
    if (!before.isFile() || before.isSymbolicLink()) throw new AgentCommitError(ErrorCodes.UnsupportedFile, 'Metadata target is not a regular file entry.')
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const fd = openSync(target, constants.O_RDONLY | noFollow)
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new AgentCommitError(ErrorCodes.Conflict, 'Metadata target identity changed before fchmod.')
      }
      fchmodSync(fd, action.mode & 0o777)
      if ((fstatSync(fd).mode & 0o777) !== (action.mode & 0o777)) throw new Error('mode verification failed')
    } finally { closeSync(fd) }
    return
  }
  if (action.type === 'restore-symlink') {
    if (process.platform === 'win32' || action.target === undefined) throw new AgentCommitError(ErrorCodes.UnsupportedFile, 'Link restore unsupported on this platform.')
    const temp = context.tempPath
    if (!temp) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'restore-symlink intent lacks its owned temp path.')
    symlinkSync(action.target, temp)
    renameSync(temp, target)
    await hook(hooks, 'after-replace', context)
  }
}

function result(
  status: RestoreExecutionResult['status'],
  plan: RestorePlan,
  journal: RestoreJournal,
  attemptId?: string,
  conflicts: Conflict[] = [],
  error?: string,
): RestoreExecutionResult {
  const completed = plan.actions.filter((action) => receiptFor(journal, action.path) || previousAction(journal, action.id)?.status === 'verified').map((action) => action.path)
  const pending = plan.actions.filter((action) => !receiptFor(journal, action.path) && previousAction(journal, action.id)?.status !== 'verified').map((action) => action.path)
  return {
    status,
    workspaceId: plan.workspaceId,
    sessionId: plan.sessionId,
    planDigest: plan.planDigest,
    ...(attemptId ? { attemptId } : {}),
    completedPaths: [...new Set(completed)],
    pendingPaths: [...new Set(pending)],
    conflicts,
    ...(error ? { error } : {}),
  }
}

export async function executeRestore(options: ExecuteRestoreOptions): Promise<RestoreExecutionResult> {
  let identity: ReturnType<typeof roots>
  try { identity = roots(options) } catch (error) {
    return { status: 'rejected', workspaceId: options.plan.workspaceId, sessionId: options.plan.sessionId, planDigest: options.plan.planDigest, completedPaths: [], pendingPaths: options.plan.actions.map((a) => a.path), conflicts: [], error: (error as Error).message }
  }
  if (activeExecutors.has(identity.workspaceId)) return { status: 'rejected', workspaceId: identity.workspaceId, sessionId: options.plan.sessionId, planDigest: options.plan.planDigest, completedPaths: [], pendingPaths: options.plan.actions.map((a) => a.path), conflicts: [], error: 'Another restore executor is active in this process.' }
  activeExecutors.add(identity.workspaceId)
  let locked = false
  let journal: RestoreJournal | undefined
  let attemptId: string | undefined
  let finalizationAttempted = false
  let durableCompletion = false
  try {
    const selected = latestRecoverable(identity.stateRoot, identity.workspaceId)
    if (selected.session.id !== options.plan.sessionId) throw new AgentCommitError(ErrorCodes.Conflict, 'Plan does not belong to the latest session.')
    journal = selected.journal
    if (!journal) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal is missing; call prepareRestore first.')
    const existingLock = readLock(identity.stateRoot, identity.workspaceId)
    if (existingLock.state === 'readable' && existingLock.content.sessionId !== options.plan.sessionId) {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'A lock from another session exists; restore may only take over its own dead-session lock.')
    }
    acquireLock(identity.stateRoot, { workspaceId: identity.workspaceId, sessionId: options.plan.sessionId, agentCommand: '(restore)' })
    locked = true
    const { pre, post } = loadBoundManifests(identity.stateRoot, identity.workspaceId, selected.session)
    const cas = new FSCasStore(identity.stateRoot)
    const changeSet = compareManifests(pre, post)
    validateRestorePlanInputs({
      root: identity.workspaceRoot,
      workspaceId: identity.workspaceId,
      sessionId: selected.session.id,
      pre,
      post,
      changeSet,
      cas,
      ...(options.plan.scope !== undefined ? { scope: options.plan.scope } : {}),
    })
    const preflightConflicts = preflight(identity, options.plan, journal, pre, post, options.forceAuthorization)
    if (preflightConflicts.length) return result('rejected', options.plan, journal, undefined, preflightConflicts)
    validateCompletedJournal(options.plan, journal, pre)
    for (const action of options.plan.actions) if (action.blobHash && !(await cas.verify(action.blobHash))) throw new AgentCommitError(ErrorCodes.BlobCorrupt, `CAS preflight failed: ${action.blobHash}`)

    if (journal.status === 'completed') {
      finalizationAttempted = true
      journal = await finalizeCompletedRestore(identity, options.plan, selected.session, journal, pre, cas, options.hooks, () => { durableCompletion = true })
      return result('succeeded', options.plan, journal)
    }

    attemptId = randomUUID()
    const firstPending = options.plan.actions.find((action) => {
      const receipt = receiptFor(journal!, action.path)
      return !receipt || observeRestoreFingerprint(identity.workspaceRoot, action.path) !== receipt.expectedFingerprint
    })
    if (!firstPending) {
      finalizationAttempted = true
      journal = await finalizeCompletedRestore(identity, options.plan, selected.session, journal, pre, cas, options.hooks, () => { durableCompletion = true })
      return result('succeeded', options.plan, journal)
    }
    journal = await saveJournal(identity.stateRoot, {
      ...journal,
      status: 'executing',
      attempts: [...journal.attempts, { id: attemptId, startedAt: new Date().toISOString(), status: 'running', actions: [] }],
    }, options.hooks, { action: firstPending, attemptId })
    const attemptIndex = journal.attempts.length - 1
    const preByPath = new Map(pre.files.map((record) => [record.path, record]))
    for (const action of options.plan.actions) {
      const prior = previousAction({ ...journal, attempts: journal.attempts.slice(0, attemptIndex) }, action.id)
      const expected = fingerprintForRecord(preByPath.get(action.path))
      assertRootIdentity(identity)
      const current = observeRestoreFingerprint(identity.workspaceRoot, action.path)
      const carried = receiptFor(journal, action.path)
      if (carried && current === carried.expectedFingerprint) continue
      if (prior?.status === 'verified') continue
      if (prior?.status === 'intent' && current === expected) {
        const recovered: RestoreJournalAction = {
          actionId: action.id,
          path: action.path,
          status: 'verified',
          beforeFingerprint: prior.beforeFingerprint,
          expectedFingerprint: prior.expectedFingerprint,
          verifiedAt: new Date().toISOString(),
          recoveredFromAttemptId: journal.attempts.slice(0, attemptIndex)
            .findLast((candidate) => candidate.actions.includes(prior))!.id,
        }
        journal.attempts[attemptIndex]!.actions.push(recovered)
        journal = await saveJournal(identity.stateRoot, journal, options.hooks, { action, attemptId })
        continue
      }
      const expectedNow = authorizedConflicts(options.plan, options.forceAuthorization).has(action.path)
        ? options.plan.conflicts.find((conflict) => conflict.path === action.path)?.currentFingerprint
        : fingerprintForRecord(new Map(post.files.map((record) => [record.path, record])).get(action.path))
      if (current !== expectedNow) throw new AgentCommitError(ErrorCodes.Conflict, `${action.path}: Current changed before intent was persisted.`)
      const tempPath = action.type === 'write-file' || action.type === 'restore-symlink'
        ? path.join(path.dirname(path.join(identity.workspaceRoot, action.path)), `.${path.basename(action.path)}.restore-${attemptId}-${action.id}-${randomUUID()}`)
        : undefined
      const intent: RestoreJournalAction = {
        actionId: action.id,
        path: action.path,
        status: 'intent',
        beforeFingerprint: current,
        expectedFingerprint: expected,
        ...(tempPath ? { tempPath } : {}),
      }
      journal.attempts[attemptIndex]!.actions.push(intent)
      journal = await saveJournal(identity.stateRoot, journal, options.hooks, { action, attemptId })
      const context: RestoreHookContext = { action, attemptId, beforeFingerprint: current, ...(tempPath ? { tempPath } : {}) }
      await hook(options.hooks, 'after-intent', context)
      await performAction(identity, action, cas, context, options.hooks)
      assertRootIdentity(identity)
      const observed = observeRestoreFingerprint(identity.workspaceRoot, action.path)
      if (observed !== expected) throw new AgentCommitError(ErrorCodes.Conflict, `${action.path}: post-action verification differs from Pre.`)
      const own = journal.attempts[attemptIndex]!.actions.find((entry) => entry.actionId === action.id)!
      own.status = 'verified'
      own.verifiedAt = new Date().toISOString()
      if (context.tempPath) own.tempPath = context.tempPath
      journal = await saveJournal(identity.stateRoot, journal, options.hooks, context)
      await hook(options.hooks, 'after-verified', context)
    }
    for (const action of options.plan.actions) {
      assertRootIdentity(identity)
      const expected = fingerprintForRecord(preByPath.get(action.path))
      if (observeRestoreFingerprint(identity.workspaceRoot, action.path) !== expected) {
        throw new AgentCommitError(ErrorCodes.Conflict, `${action.path}: final whole-plan verification drifted from Pre.`)
      }
    }
    journal.attempts[attemptIndex]!.status = 'completed'
    journal.attempts[attemptIndex]!.endedAt = new Date().toISOString()
    finalizationAttempted = true
    journal = await finalizeCompletedRestore(identity, options.plan, selected.session, journal, pre, cas, options.hooks, () => { durableCompletion = true }, attemptId)
    return result('succeeded', options.plan, journal, attemptId)
  } catch (error) {
    if (journal && attemptId) {
      if (!durableCompletion && journal.status !== 'completed') {
        const index = journal.attempts.findIndex((attempt) => attempt.id === attemptId)
        if (index >= 0) {
          journal.attempts[index]!.status = 'failed'
          journal.attempts[index]!.endedAt = new Date().toISOString()
          journal.attempts[index]!.error = (error as Error).message
          journal.status = journal.attempts.some((attempt) => attempt.actions.some((action) => action.status === 'verified')) ? 'partial' : 'prepared'
          try { journal = persistRestoreJournal(identity.stateRoot, journal) } catch { /* fail closed; original plus stale running journal remain recoverable */ }
        }
      }
      try {
        const session = loadSession(identity.stateRoot, identity.workspaceId, options.plan.sessionId)
        persistSession(identity.stateRoot, identity.workspaceId, { ...session, status: SessionStatus.RollbackFailed })
      } catch { /* journal remains authoritative */ }
      const status = journal.attempts.some((attempt) => attempt.actions.some((action) => action.status === 'verified')) ? 'partial' : 'retryable'
      return result(status, options.plan, journal, attemptId, [], (error as Error).message)
    }
    if (journal && finalizationAttempted) {
      const status = journal.attempts.some((attempt) => attempt.actions.some((action) => action.status === 'verified')) ? 'partial' : 'retryable'
      return result(status, options.plan, journal, undefined, [], (error as Error).message)
    }
    const fallback = journal ?? { attempts: [] } as unknown as RestoreJournal
    return result('rejected', options.plan, fallback, undefined, [], (error as Error).message)
  } finally {
    if (locked) releaseLock(identity.stateRoot, identity.workspaceId, options.plan.sessionId)
    activeExecutors.delete(identity.workspaceId)
  }
}
