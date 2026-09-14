import { existsSync } from 'node:fs'
import { Session, SessionStatus } from '../session/types.js'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { atomicWriteJson, readJson } from './atomic.js'
import { sessionPath } from './paths.js'

export interface NewSessionInput {
  sessionId: string
  workspaceId: string
  agent: { kind: string; command: string; version?: string }
}

/** Create the initial in-memory session record (status: ready). */
export function newSessionRecord(input: NewSessionInput): Session {
  return {
    id: input.sessionId,
    workspaceId: input.workspaceId,
    agent: input.agent,
    startedAt: new Date().toISOString(),
    status: SessionStatus.Ready,
    changes: [],
    conflicts: [],
  }
}

/** Persist session metadata with the atomic write protocol. */
export function persistSession(
  stateRoot: string,
  workspaceId: string,
  session: Session,
): void {
  atomicWriteJson(sessionPath(stateRoot, workspaceId, session.id), session)
}

/** Load a persisted session; absence or integrity failure throws STATE_CORRUPT. */
export function loadSession(
  stateRoot: string,
  workspaceId: string,
  sessionId: string,
): Session {
  const p = sessionPath(stateRoot, workspaceId, sessionId)
  if (!existsSync(p)) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Session record not found: ${sessionId}`,
    )
  }
  const raw = readJson<Session>(p)
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as Session).id !== 'string' ||
    typeof (raw as Session).status !== 'string'
  ) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Session record failed an integrity check: ${p}`,
    )
  }
  return raw
}
