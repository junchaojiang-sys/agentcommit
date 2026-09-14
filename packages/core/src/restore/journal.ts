import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { atomicWriteJson, readJson } from '../storage/atomic.js'
import { sessionsDir, workspaceDir } from '../storage/paths.js'
import { loadRestorePlan, restorePlanDigest } from './plan.js'
import type { RestoreJournal } from './types.js'

export function restoreJournalPath(
  stateRoot: string,
  workspaceId: string,
  sessionId: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal session id is not a safe state identifier.')
  }
  return path.join(sessionsDir(stateRoot, workspaceId), `${sessionId}.journal.json`)
}

export function archivedRestoreJournalPath(
  stateRoot: string,
  workspaceId: string,
  sessionId: string,
  planId: string,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(planId)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal archive id is not a safe state identifier.')
  }
  return path.join(workspaceDir(stateRoot, workspaceId), 'journal-history', sessionId, `${planId}.json`)
}

function journalDigest(journal: Omit<RestoreJournal, 'journalDigest'>): string {
  return createHash('sha256').update(JSON.stringify(journal), 'utf8').digest('hex')
}

export function sealRestoreJournal(
  journal: Omit<RestoreJournal, 'journalDigest'>,
): RestoreJournal {
  return { ...journal, journalDigest: journalDigest(journal) }
}

function validateJournal(
  stateRoot: string,
  journal: RestoreJournal,
  expected: { workspaceId: string; sessionId: string },
): void {
  if (
    journal.schemaVersion !== 1 ||
    journal.workspaceId !== expected.workspaceId ||
    journal.sessionId !== expected.sessionId ||
    !journal.plan ||
    journal.plan.workspaceId !== expected.workspaceId ||
    journal.plan.sessionId !== expected.sessionId ||
    journal.plan.planDigest !== journal.planDigest ||
    !Array.isArray(journal.attempts) ||
    !['prepared', 'executing', 'partial', 'completed'].includes(journal.status)
  ) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal binding/shape is invalid.')
  }
  const { journalDigest: _stored, ...body } = journal
  const { planDigest: _planDigest, ...planBody } = journal.plan
  if (restorePlanDigest(planBody) !== journal.plan.planDigest || journalDigest(body) !== _stored) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal integrity check failed.')
  }
  const persistedPlan = loadRestorePlan(stateRoot, expected.workspaceId, journal.plan.planId)
  if (JSON.stringify(persistedPlan) !== JSON.stringify(journal.plan)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal plan differs from its persisted immutable plan.')
  }
  const attemptIds = new Set<string>()
  for (const [attemptIndex, attempt] of journal.attempts.entries()) {
    if (!attempt || typeof attempt.id !== 'string' || attemptIds.has(attempt.id) ||
        !Number.isFinite(Date.parse(attempt.startedAt)) ||
        !['running', 'failed', 'completed'].includes(attempt.status) || !Array.isArray(attempt.actions)) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal attempt structure is invalid.')
    }
    attemptIds.add(attempt.id)
    const actionIds = new Set<string>()
    for (const action of attempt.actions) {
      const planned = journal.plan.actions.find((candidate) => candidate.id === action?.actionId)
      if (!action || typeof action.actionId !== 'string' || actionIds.has(action.actionId) ||
          typeof action.path !== 'string' || typeof action.beforeFingerprint !== 'string' ||
          typeof action.expectedFingerprint !== 'string' || !['intent', 'verified'].includes(action.status) ||
          !planned || planned.path !== action.path) {
        throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal action structure is invalid.')
      }
      if (action.tempPath !== undefined) {
        const target = path.join(journal.plan.workspaceRootReal ?? '', action.path)
        const expectedPrefix = `.${path.basename(action.path)}.restore-${attempt.id}-${action.actionId}-`
        if (!path.isAbsolute(action.tempPath) || path.dirname(action.tempPath) !== path.dirname(target) ||
            !path.basename(action.tempPath).startsWith(expectedPrefix)) {
          throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal temp ownership binding is invalid.')
        }
      }
      if (action.status === 'verified' && !Number.isFinite(Date.parse(action.verifiedAt ?? ''))) {
        throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal verified action timestamp is invalid.')
      }
      if (action.recoveredFromAttemptId !== undefined) {
        const sourceIndex = journal.attempts.findIndex((candidate) => candidate.id === action.recoveredFromAttemptId)
        const source = sourceIndex >= 0
          ? journal.attempts[sourceIndex]!.actions.find((candidate) => candidate.actionId === action.actionId)
          : undefined
        if (action.status !== 'verified' || action.tempPath !== undefined || sourceIndex < 0 || sourceIndex >= attemptIndex ||
            !source || source.status !== 'intent' || source.path !== action.path ||
            source.beforeFingerprint !== action.beforeFingerprint ||
            source.expectedFingerprint !== action.expectedFingerprint) {
          throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal recovered action provenance is invalid.')
        }
      }
      actionIds.add(action.actionId)
    }
  }
  const receiptPaths = new Set<string>()
  for (const receipt of journal.completedReceipts ?? []) {
    if (!receipt || typeof receipt.path !== 'string' || receiptPaths.has(receipt.path) ||
        typeof receipt.expectedFingerprint !== 'string' || typeof receipt.planId !== 'string' ||
        typeof receipt.planDigest !== 'string' || typeof receipt.attemptId !== 'string') {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal receipt structure is invalid.')
    }
    receiptPaths.add(receipt.path)
    const sourcePlan = loadRestorePlan(stateRoot, expected.workspaceId, receipt.planId)
    if (sourcePlan.sessionId !== expected.sessionId || sourcePlan.planDigest !== receipt.planDigest ||
        !sourcePlan.actions.some((action) => action.path === receipt.path)) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal receipt source binding is invalid.')
    }
    const archivedPath = archivedRestoreJournalPath(stateRoot, expected.workspaceId, expected.sessionId, receipt.planId)
    let archived: RestoreJournal
    try { archived = readJson<RestoreJournal>(archivedPath) } catch (error) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal receipt archive is missing or unreadable.', { cause: error })
    }
    const { journalDigest: archivedDigest, ...archivedBody } = archived
    const sourceAttempt = archived.attempts.find((attempt) => attempt.id === receipt.attemptId)
    const sourceAction = sourceAttempt?.actions.find((action) => action.path === receipt.path && action.status === 'verified')
    if (archivedDigest !== journalDigest(archivedBody) || archived.planDigest !== receipt.planDigest ||
        archived.sessionId !== expected.sessionId || !sourceAction ||
        sourceAction.expectedFingerprint !== receipt.expectedFingerprint) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal receipt archive binding is invalid.')
    }
  }
}

export function loadRestoreJournal(
  stateRoot: string,
  workspaceId: string,
  sessionId: string,
): RestoreJournal | undefined {
  const file = restoreJournalPath(stateRoot, workspaceId, sessionId)
  try {
    if (!lstatSync(file).isFile()) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, `Restore Journal is not a regular file: ${file}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof AgentCommitError) throw error
    throw new AgentCommitError(ErrorCodes.StateCorrupt, `Restore Journal cannot be inspected: ${file}`, { cause: error })
  }
  let journal: RestoreJournal
  try {
    journal = readJson<RestoreJournal>(file)
  } catch (error) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, `Restore Journal is unreadable: ${file}`, { cause: error })
  }
  validateJournal(stateRoot, journal, { workspaceId, sessionId })
  return journal
}

export function persistRestoreJournal(
  stateRoot: string,
  journal: Omit<RestoreJournal, 'journalDigest'> | RestoreJournal,
): RestoreJournal {
  const { journalDigest: _old, ...body } = journal as RestoreJournal
  const sealed = sealRestoreJournal(body)
  atomicWriteJson(restoreJournalPath(stateRoot, sealed.workspaceId, sealed.sessionId), sealed)
  return sealed
}

export function archiveRestoreJournal(stateRoot: string, journal: RestoreJournal): void {
  const target = archivedRestoreJournalPath(stateRoot, journal.workspaceId, journal.sessionId, journal.plan.planId)
  try {
    const stat = lstatSync(target)
    if (!stat.isFile()) throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal archive target is not a regular file.')
  } catch (error) {
    if (error instanceof AgentCommitError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      atomicWriteJson(target, journal)
      return
    }
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal archive cannot be inspected.', { cause: error })
  }
  let existing: RestoreJournal
  try { existing = readJson<RestoreJournal>(target) } catch (error) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal archive is corrupt.', { cause: error })
  }
  if (JSON.stringify(existing) !== JSON.stringify(journal)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Restore Journal archive already exists with different content.')
  }
}
