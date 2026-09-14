import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { SessionStatus } from '../session/types.js'
import { sessionsDir } from './paths.js'
import { loadRestoreJournal } from '../restore/journal.js'

/** Session states that still own the workspace transaction. */
const KNOWN_STATUSES: ReadonlySet<string> = new Set(Object.values(SessionStatus))

const NON_TERMINAL: ReadonlySet<string> = new Set([
  SessionStatus.Ready,
  SessionStatus.Snapshot,
  SessionStatus.Running,
  SessionStatus.Review,
  SessionStatus.RollbackFailed,
])

export interface AdmissionCheck {
  eligible: boolean
  blockers: string[]
}

/**
 * Read-only recovery admission (P2-A).
 *
 * Fail-closed rules:
 * - ENOENT on the sessions dir ⇒ no sessions yet, eligible.
 * - Any other readdir error (EACCES, ENOTDIR…) ⇒ NOT eligible.
 * - Unreadable/corrupt/unknown-status session files ⇒ NOT eligible.
 * - A session whose status is in the frozen non-terminal set ⇒ NOT eligible.
 *
 * The caller must pass `excludeSessionId` to skip its own session record.
 * PID death never proves a transaction is finished (P1 P2-backlog).
 */
export function sessionAdmission(
  stateRoot: string,
  workspaceId: string,
  options: { excludeSessionId?: string } = {},
): AdmissionCheck {
  const blockers: string[] = []
  const dir = sessionsDir(stateRoot, workspaceId)
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Sessions directory doesn't exist yet: no sessions for this workspace.
      return { eligible: true, blockers: [] }
    }
    // Permission denied, ENOTDIR, etc.: cannot confirm absence ⇒ fail closed.
    return {
      eligible: false,
      blockers: [`sessions dir unreadable: ${(error as Error).message}`],
    }
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    if (file.endsWith('.journal.json')) {
      const sessionId = file.slice(0, -'.journal.json'.length)
      try {
        const journal = loadRestoreJournal(stateRoot, workspaceId, sessionId)
        if (!journal) {
          blockers.push(`${sessionId} (corrupt restore journal)`)
        } else if (journal.status !== 'completed' || journal.plan.scope !== undefined) {
          // A recovery journal belongs to the transaction even when the
          // caller excludes that session's ordinary record.
          blockers.push(`${sessionId} (unfinished restore journal)`)
        }
      } catch {
        blockers.push(`${sessionId} (corrupt restore journal)`)
      }
      continue
    }
    const sessionId = file.slice(0, -'.json'.length)
    if (sessionId === options.excludeSessionId) continue
    let status: string | undefined
    try {
      const raw: unknown = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        blockers.push(`${sessionId} (invalid session structure)`)
        continue
      }
      status = (raw as { status?: unknown }).status as string | undefined
    } catch {
      // Corrupt JSON: treat as blocker (fail closed).
      blockers.push(`${sessionId} (corrupt session file)`)
      continue
    }
    if (typeof status !== 'string' || !KNOWN_STATUSES.has(status)) {
      // Unknown or missing status: cannot confirm the session is finished.
      blockers.push(`${sessionId} (unknown status: ${JSON.stringify(status)})`)
      continue
    }
    if (NON_TERMINAL.has(status)) {
      blockers.push(`${sessionId} (status: ${status})`)
    }
  }
  return { eligible: blockers.length === 0, blockers }
}
