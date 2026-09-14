import { AgentCommitError, ErrorCodes, inspectSession, listWorkspaceSessions, resolveStateRoot, resolveWorkspace } from '@agentcommit/core'

export function context() {
  return { workspaceRoot: resolveWorkspace().root, stateRoot: resolveStateRoot() }
}

export function latestDetails(sessionId?: string) {
  const options = context()
  if (!sessionId && listWorkspaceSessions(options).length === 0) {
    throw new AgentCommitError(ErrorCodes.Conflict, 'No Session exists in this workspace.')
  }
  return inspectSession({ ...options, ...(sessionId ? { sessionId } : {}) })
}
