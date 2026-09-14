import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import type { CasStore } from '../cas/types.js'
import type { Change, ChangeSet } from '../diff/types.js'
import { ChangeAssessments, ChangeKinds } from '../diff/types.js'
import { BUILTIN_RULES_VERSION, policyDigest } from '../snapshot/policy.js'
import type { Manifest } from '../snapshot/types.js'
import { ConflictKinds, ExpectedCurrentStates, type ExpectedCurrentState, type RestorePlan } from './types.js'
import { observeCurrent, type CurrentObservation } from './observe.js'
import { atomicWriteJson, readJson } from '../storage/atomic.js'
import { workspaceDir } from '../storage/paths.js'
import { compareManifests } from '../diff/changeset.js'
import { observationPathProblem, validateRestorePath } from './path-safety.js'
export { validateRestorePath, parentLinkEscape } from './path-safety.js'

export interface BuildRestorePlanOptions {
  root: string
  workspaceId: string
  sessionId: string
  pre: Manifest
  post: Manifest
  changeSet: ChangeSet
  cas: CasStore
  /** Cap used for Current hashing (defaults to the policy cap passed in). */
  maxHashSizeBytes?: number
  /** Injectable plan id (tests). */
  planId?: string
  /**
   * Explicit scope (path prefix): only changes under this prefix participate.
   * Recorded on the plan so out-of-scope changes are visibly NOT omitted by
   * accident. Absent = full scope.
   */
  scope?: string
}

export interface BuiltRestorePlan {
  plan: RestorePlan
  /** Fresh Current observations at planning time (for tests/inspection). */
  current: Map<string, CurrentObservation>
}

function classifyCurrent(
  obs: CurrentObservation | undefined,
  expected: { exists: boolean; type?: string; hash?: string; symlinkTarget?: string },
): ExpectedCurrentState {
  if (!obs) return ExpectedCurrentStates.Unknown
  if (obs.error) return ExpectedCurrentStates.Unknown
  // A clean absence observation (lstat succeeded, nothing there) IS reliable.
  if (!obs.exists) return ExpectedCurrentStates.Absent
  if (!expected.exists) return ExpectedCurrentStates.Differs
  if (expected.type === 'file' && obs.type === 'file') {
    if (expected.hash !== undefined && obs.hash !== undefined) {
      return obs.hash === expected.hash
        ? ExpectedCurrentStates.MatchesPost
        : ExpectedCurrentStates.Differs
    }
    return ExpectedCurrentStates.Unknown
  }
  if (expected.type === 'symlink' && obs.type === 'symlink') {
    return obs.symlinkTarget === expected.symlinkTarget
      ? ExpectedCurrentStates.MatchesPost
      : ExpectedCurrentStates.Differs
  }
  return ExpectedCurrentStates.Differs
}

export function restorePlanDigest(plan: Omit<RestorePlan, 'planDigest'>): string {
  return createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex')
}

/** Validate the frozen input contract without workspace or CAS access. */
export function validateRestorePlanInputs(options: BuildRestorePlanOptions): string {
  const { pre, post, changeSet } = options
  try {
    if (typeof options.workspaceId !== 'string' || !options.workspaceId ||
        typeof options.sessionId !== 'string' || !options.sessionId ||
        typeof options.root !== 'string' || !options.root) {
      throw new Error('missing identity/root')
    }
    for (const manifest of [pre, post]) {
      if (manifest.schemaVersion !== 2 || typeof manifest.id !== 'string' || !manifest.id ||
          manifest.workspaceId !== options.workspaceId || manifest.sessionId !== options.sessionId ||
          !Array.isArray(manifest.files) || !Array.isArray(manifest.ignored)) {
        throw new Error('Manifest identity/structure mismatch')
      }
      const policy = manifest.protectionPolicy
      if (!policy || policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.maxFileSizeBytes) || policy.maxFileSizeBytes < 0 ||
          manifest.maxFileSizeBytes !== policy.maxFileSizeBytes || policy.builtinRulesVersion !== BUILTIN_RULES_VERSION ||
          !Array.isArray(policy.builtinRules) || !policy.builtinRules.every((r) => typeof r === 'string') ||
          !Array.isArray(policy.ignoreRules) || !policy.ignoreRules.every((r) => typeof r === 'string') ||
          !(policy.ignoreFileSha256 === null || (typeof policy.ignoreFileSha256 === 'string' && /^[a-f0-9]{64}$/.test(policy.ignoreFileSha256)))) {
        throw new Error('invalid frozen protection policy')
      }
      const paths = new Set<string>()
      for (const record of manifest.files) {
        if (!record || typeof record.path !== 'string' || paths.has(record.path) ||
            !['file', 'symlink', 'junction', 'reparse', 'unsupported'].includes(record.type) ||
            typeof record.protected !== 'boolean' || !Number.isFinite(record.size) || record.size < 0) {
          throw new Error('invalid Manifest file record')
        }
        paths.add(record.path)
      }
    }
    const digest = policyDigest(pre.protectionPolicy)
    if (pre.id === post.id || digest !== policyDigest(post.protectionPolicy)) throw new Error('Pre/Post identity or policy mismatch')
    if (changeSet.schemaVersion !== 1 || changeSet.preManifestRef !== pre.id || changeSet.postManifestRef !== post.id ||
        !Array.isArray(changeSet.entries)) throw new Error('ChangeSet Manifest reference mismatch')
    // Compare serialized data: optional undefined fields disappear on save/load.
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(changeSet)), JSON.parse(JSON.stringify(compareManifests(pre, post))))) throw new Error('ChangeSet does not match manifests')
    if (options.scope !== undefined && validateRestorePath(options.scope)) throw new Error('invalid scope')
    if (options.maxHashSizeBytes !== undefined && (!Number.isSafeInteger(options.maxHashSizeBytes) || options.maxHashSizeBytes < 0)) throw new Error('invalid observation cap')
    return digest
  } catch (error) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, `Invalid RestorePlan input: ${(error as Error).message}`)
  }
}

/**
 * Phase 2-A: build the immutable READ-ONLY restore plan (no execution).
 *
 * First-planning rules (docs/TRANSACTION_MODEL §5/§7):
 * - modified: Current == Post ⇒ plan restore of Pre; Current != Post ⇒ CONFLICT;
 *   unknown ⇒ conflict (blocked from planning).
 * - created: Current == Post ⇒ plan delete of this session's file; differs ⇒ CONFLICT.
 * - deleted: Current still absent ⇒ plan restore of Pre; path recreated ⇒ CONFLICT.
 * - unchanged paths never produce actions.
 * Current == Pre is NEVER treated as "this tool already restored" — that
 * recognition needs the Phase 2-B journal context.
 */
export async function buildRestorePlan(options: BuildRestorePlanOptions): Promise<BuiltRestorePlan> {
  const { pre, post, changeSet, cas } = options
  const digest = validateRestorePlanInputs(options)
  const maxHash = options.maxHashSizeBytes ?? pre.maxFileSizeBytes

  const entries = options.scope
    ? changeSet.entries.filter(
        (c) => c.path === options.scope || c.path.startsWith(options.scope + '/'),
      )
    : changeSet.entries
  const actions: RestorePlan['actions'] = []
  const preModeByPath = new Map(pre.files.map(f => [f.path, f.mode]))
  const postModeByPath = new Map(post.files.map(f => [f.path, f.mode]))
  const conflicts: RestorePlan['conflicts'] = []
  const blocked: RestorePlan['blocked'] = []
  const coverageWarnings: string[] = []
  const safeEntries = entries.filter((change) => {
    const problem = observationPathProblem(options.root, change.path)
    if (problem) blocked.push({ path: change.path, reason: `out of restore scope: ${problem}` })
    return problem === null
  })
  const pathsToObserve = safeEntries.filter((c) => c.assessment === ChangeAssessments.Ready).map((c) => c.path)
  const current = observeCurrent(options.root, pathsToObserve, { maxHashSizeBytes: maxHash })
  let verifiedBlobs = true
  let order = 0

  for (const change of safeEntries as Change[]) {
    if (change.assessment === ChangeAssessments.CapabilityGap) {
      blocked.push({
        path: change.path,
        reason: `capability gap (${change.kind}): ${change.note ?? 'side not protectable'} — cannot plan safely`,
      })
      coverageWarnings.push(`${change.path}: unprotected/inaccessible — not covered by this plan`)
      continue
    }
    if (change.assessment === ChangeAssessments.RequiresDecision) {
      blocked.push({
        path: change.path,
        reason: `requires decision: ${change.note ?? 'pending OQ'} (OQ-07/OQ-08/OQ-09 belong to the user)`,
      })
      continue
    }

    const obs = current.get(change.path)
    const preRecMode = preModeByPath.get(change.path)
    const postRecMode = postModeByPath.get(change.path)
    // OQ-07 drift rule (POSIX only): when the post record carries rwx bits and the
    // observed current file carries different bits, the mode changed after the
    // session — a conflict, never a silent chmod.
    const modeDrift = (): boolean => {
      if (process.platform === 'win32' || postRecMode === undefined || obs?.type !== 'file' || obs.mode === undefined) return false
      return obs.mode !== (postRecMode & 0o777)
    }
    const actionOrder = order++

    if (change.kind === ChangeKinds.Created) {
      // Pre absent; Post exists (protected). A directory at this path now can
      // never be "planned away" — explicit BLOCKED before any conflict logic.
      if (obs?.type === 'directory') {
        blocked.push({
          path: change.path,
          reason: 'created path is now a directory — unsafe to plan removal',
        })
        continue
      }
      // R2 (POSIX, post side): removing a session-created file is guarded by a
      // full Current==Post comparison before the unlink. Without Post rwx
      // evidence that guard cannot be evaluated (a tolerant comparison would
      // erase exactly the mode check this policy rests on), so block BEFORE any
      // selected target is touched. Created paths legally have no Pre side —
      // this gate is about the Post record only; links carry no file mode.
      if (process.platform !== 'win32' && change.post?.type === 'file' && postRecMode === undefined) {
        blocked.push({
          path: change.path,
          reason: 'legacy Post manifest has no rwx evidence for this created regular file on POSIX; the pre-delete Current guard cannot be satisfied — refusing to start a partially verifiable restore',
        })
        continue
      }
      // Delete this session's file only if Current still matches Post.
      const state = classifyCurrent(obs, {
        exists: true,
        type: change.post?.type,
        hash: change.post?.hash,
        symlinkTarget: change.post?.symlinkTarget,
      })
      if (state !== ExpectedCurrentStates.MatchesPost) {
        conflicts.push({
          path: change.path,
          kind: ConflictKinds.UserEditedCreatedFile,
          currentHash: obs?.hash,
          expectedPostHash: change.post?.hash,
          message:
            state === ExpectedCurrentStates.Unknown
              ? 'Current could not be reliably observed'
              : 'Current differs from what the session created (user/external edit)',
        })
        continue
      }
      actions.push({
        id: `action-${String(actions.length + 1).padStart(3, '0')}`,
        type: 'delete-path',
        path: change.path,
        expectedCurrent: state,
        order: actionOrder,
      })
      continue
    }

    if (change.kind === ChangeKinds.Modified) {
      const preSide = change.pre
      if (!preSide) {
        blocked.push({ path: change.path, reason: 'missing pre side for modified path' })
        continue
      }
      const state = classifyCurrent(obs, {
        exists: true,
        type: 'file',
        hash: change.post?.hash,
        symlinkTarget: change.post?.symlinkTarget,
      })
      if (state !== ExpectedCurrentStates.MatchesPost) {
        conflicts.push({
          path: change.path,
          kind: ConflictKinds.UserModifiedAfterSession,
          currentHash: obs?.hash,
          expectedPostHash: change.post?.hash,
          message:
            state === ExpectedCurrentStates.Unknown
              ? 'Current could not be reliably observed'
              : 'Current differs from the session post state (user/external edit)',
        })
        continue
      }
      // R2 (POSIX): restoring regular-file bytes whose Pre record carries no rwx
      // evidence is unsafe — we would write under an unverifiable mode. The
      // conservative policy blocks BEFORE any write; no permission guessing, no
      // default-0644 substitution, no write-then-fail. Link records (symlink/
      // junction) legitimately carry no mode; they are recreated as links below.
      if (process.platform !== 'win32' && preSide.type === 'file' && preRecMode === undefined) {
        blocked.push({
          path: change.path,
          reason: 'legacy Pre manifest has no rwx evidence for this regular file on POSIX; no authorized compatibility policy — refusing a permission-blind content restore',
        })
        continue
      }
      // R2 (POSIX, post side): a content restore is guarded by more than Pre
      // evidence — the pre-write/pre-intent Current checks compare against the
      // Post fingerprint and the post-plan drift check compares rwx bits with
      // the Post record. A Post record without rwx evidence can never satisfy
      // those guards (contentMatches would pass it only by ignoring mode), so
      // the conservative policy blocks BEFORE any selected target is written
      // instead of half-executing and failing mid-plan. Deleted paths legally
      // have no Post side; links carry no file mode by design.
      if (process.platform !== 'win32' && change.post?.type === 'file' && postRecMode === undefined) {
        blocked.push({
          path: change.path,
          reason: 'legacy Post manifest has no rwx evidence for this regular file on POSIX; the Current and chmod-drift guards cannot be satisfied — refusing to start a partially verifiable restore',
        })
        continue
      }
      // Link-target-only change: plan link recreation, no blob read needed.
      if (change.note === 'link-target-changed' && preSide.symlinkTarget) {
        actions.push({
          id: `action-${String(actions.length + 1).padStart(3, '0')}`,
          type: 'restore-symlink',
          path: change.path,
          target: preSide.symlinkTarget,
          expectedCurrent: state,
          order: actionOrder,
        })
        continue
      }
      if (!preSide.hash) {
        blocked.push({ path: change.path, reason: 'pre side has no restorable content snapshot' })
        continue
      }
      if (!(await cas.has(preSide.hash))) {
        verifiedBlobs = false
        conflicts.push({
          path: change.path,
          kind: ConflictKinds.Unrecoverable,
          message: `pre-blob missing in CAS: ${preSide.hash}`,
        })
        continue
      }
      if (!(await cas.verify(preSide.hash))) {
        verifiedBlobs = false
        conflicts.push({
          path: change.path,
          kind: ConflictKinds.Unrecoverable,
          message: `pre-blob corrupt in CAS: ${preSide.hash}`,
        })
        continue
      }
      if (modeDrift()) {
        conflicts.push({
          path: change.path,
          kind: ConflictKinds.UserModifiedAfterSession,
          currentHash: obs?.hash,
          message: 'Current rwx bits no longer match the session post state (mode drift)',
        })
        continue
      }
      actions.push({
        id: `action-${String(actions.length + 1).padStart(3, '0')}`,
        type: 'write-file',
        path: change.path,
        blobHash: preSide.hash,
        ...(preRecMode !== undefined ? { mode: preRecMode & 0o777 } : {}),
        expectedCurrent: state,
        order: actionOrder,
      })
      continue
    }

    if (change.kind === ChangeKinds.MetadataOnly) {
      // Mode-only change (OQ-07): content is identical between pre and post, so
      // Current must still match that content, and its rwx bits must match post.
      const preSide = change.pre
      if (!preSide) {
        blocked.push({ path: change.path, reason: 'missing pre side for metadata-only path' })
        continue
      }
      if (preRecMode === undefined || postRecMode === undefined) {
        blocked.push({ path: change.path, reason: 'mode-only change lacks a recorded pre/post rwx contract (legacy manifest) — refusing to guess permissions' })
        continue
      }
      const state = classifyCurrent(obs, {
        exists: true,
        type: 'file',
        hash: preSide.hash,
      })
      if (state !== ExpectedCurrentStates.MatchesPost) {
        conflicts.push({
          path: change.path,
          kind: ConflictKinds.UserModifiedAfterSession,
          currentHash: obs?.hash,
          message: 'Current no longer matches the unchanged content of the session post state',
        })
        continue
      }
      if (modeDrift()) {
        conflicts.push({
          path: change.path,
          kind: ConflictKinds.UserModifiedAfterSession,
          currentHash: obs?.hash,
          message: 'Current rwx bits no longer match the session post state (mode drift)',
        })
        continue
      }
      actions.push({
        id: `action-${String(actions.length + 1).padStart(3, '0')}`,
        type: 'restore-metadata',
        path: change.path,
        mode: preRecMode & 0o777,
        expectedCurrent: state,
        order: actionOrder,
      })
      continue
    }

    if (change.kind === ChangeKinds.Deleted) {
      const preSide = change.pre
      if (!preSide) {
        blocked.push({ path: change.path, reason: 'missing pre side for deleted path' })
        continue
      }
      if (obs && obs.exists && obs.type === 'directory') {
        blocked.push({
          path: change.path,
          reason: 'a directory now exists at the deleted path — refuse to plan recursive removal',
        })
        continue
      }
      const state = classifyCurrent(obs, { exists: false })
      // R2 (POSIX): same conservative rule for deleted regular files — recreating
      // file bytes without rwx evidence is permission-blind. Links carry no mode
      // by design and are restored as links below.
      if (process.platform !== 'win32' && preSide.type === 'file' && preRecMode === undefined) {
        blocked.push({
          path: change.path,
          reason: 'legacy Pre manifest has no rwx evidence for this deleted path on POSIX; no authorized compatibility policy — refusing a permission-blind recreation',
        })
        continue
      }
      if (state === ExpectedCurrentStates.Absent && preSide.hash) {
        if (!(await cas.has(preSide.hash))) {
          verifiedBlobs = false
          conflicts.push({
            path: change.path,
            kind: ConflictKinds.Unrecoverable,
            message: `pre-blob missing in CAS: ${preSide.hash}`,
          })
          continue
        }
        if (!(await cas.verify(preSide.hash))) {
          verifiedBlobs = false
          conflicts.push({
            path: change.path,
            kind: ConflictKinds.Unrecoverable,
            message: `pre-blob corrupt in CAS: ${preSide.hash}`,
          })
          continue
        }
        actions.push({
          id: `action-${String(actions.length + 1).padStart(3, '0')}`,
          type: 'write-file',
          path: change.path,
          blobHash: preSide.hash,
          expectedCurrent: ExpectedCurrentStates.Absent,
          order: actionOrder,
        })
        continue
      }
      if (state === ExpectedCurrentStates.Absent && preSide.symlinkTarget) {
        actions.push({
          id: `action-${String(actions.length + 1).padStart(3, '0')}`,
          type: 'restore-symlink',
          path: change.path,
          target: preSide.symlinkTarget,
          expectedCurrent: ExpectedCurrentStates.Absent,
          order: actionOrder,
        })
        continue
      }
      if (state === ExpectedCurrentStates.Absent && !preSide.protected) {
        blocked.push({
          path: change.path,
          reason: 'deleted path was never protectable — capability gap',
        })
        continue
      }
      conflicts.push({
        path: change.path,
        kind: ConflictKinds.PathRecreatedAfterDelete,
        currentHash: obs?.hash,
        message: 'a new path appeared where the session deleted one — refuse to overwrite',
      })
      continue
    }

    if (change.kind === ChangeKinds.TypeChanged) {
      blocked.push({ path: change.path, reason: 'type changed between pre and post — no safe automatic plan' })
      continue
    }
    blocked.push({ path: change.path, reason: 'unclassifiable change' })
  }

  // Deletions always execute after writes in the plan ordering.
  actions.sort((a, b) => {
    const aDel = a.type === 'delete-path' ? 1 : 0
    const bDel = b.type === 'delete-path' ? 1 : 0
    return aDel - bDel || a.order - b.order
  })
  actions.forEach((a, idx) => {
    a.order = idx
  })

  const base: Omit<RestorePlan, 'planDigest'> = {
    schemaVersion: 1,
    planId: options.planId ?? randomUUID(),
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    preManifestRef: pre.id,
    postManifestRef: post.id,
    policyDigest: digest,
    ...(options.scope ? { scope: options.scope } : {}),
    actions,
    conflicts,
    blocked,
    coverageWarnings,
    verifiedBlobs,
    force: false,
  }
  const plan: RestorePlan = { ...base, planDigest: restorePlanDigest(base) }
  return { plan, current }
}

export function planPath(stateRoot: string, workspaceId: string, planId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(planId)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore plan id is not a safe state identifier.')
  }
  return path.join(workspaceDir(stateRoot, workspaceId), 'plans', `${planId}.json`)
}

/** Persist a plan (atomic). Saving is a RECOMMENDATION record, not a permit. */
export function saveRestorePlan(
  stateRoot: string,
  workspaceId: string,
  plan: RestorePlan,
): void {
  atomicWriteJson(planPath(stateRoot, workspaceId, plan.planId), plan)
}

/** Load + verify binding and digest; any drift ⇒ STATE_CORRUPT. */
export function loadRestorePlan(
  stateRoot: string,
  workspaceId: string,
  planId: string,
): RestorePlan {
  const p = planPath(stateRoot, workspaceId, planId)
  if (!existsSync(p)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, `Restore plan not found: ${planId}`)
  }
  const plan = readJson<RestorePlan>(p)
  if (plan.schemaVersion !== 1 || plan.planId !== planId || !Array.isArray(plan.actions) ||
      !Array.isArray(plan.conflicts) || !Array.isArray(plan.blocked) ||
      plan.force !== false || (plan.scope !== undefined && validateRestorePath(plan.scope))) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore plan failed its shape/binding check.')
  }
  if (plan.workspaceId !== workspaceId) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore plan belongs to another workspace.')
  }
  const { planDigest: _digest, ...rest } = plan
  void _digest
  if (restorePlanDigest(rest) !== plan.planDigest) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Restore plan failed its integrity check: ${planId}`,
    )
  }
  return plan
}
