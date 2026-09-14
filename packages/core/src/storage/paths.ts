import os from 'node:os'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { ensureDir } from './atomic.js'

/**
 * Frozen local state layout (docs/STORAGE.md §2):
 *   Windows: %LOCALAPPDATA%\AgentCommit   Unix: ~/.agentcommit
 * AGENTCOMMIT_STATE_DIR overrides the root — an isolation hook for tests and
 * sandboxed environments; the on-disk layout is identical.
 */
export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENTCOMMIT_STATE_DIR']
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override)
  }
  if (process.platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']
    if (localAppData !== undefined && localAppData.trim() !== '') {
      return path.join(localAppData, 'AgentCommit')
    }
    const home = os.homedir()
    if (home !== '') {
      return path.join(home, 'AppData', 'Local', 'AgentCommit')
    }
  } else {
    const home = os.homedir()
    if (home !== '') {
      return path.join(home, '.agentcommit')
    }
  }
  throw new AgentCommitError(
    ErrorCodes.StateCorrupt,
    'Cannot resolve the AgentCommit state directory (no home directory available).',
  )
}

export function blobsRoot(stateRoot: string): string {
  return path.join(stateRoot, 'blobs', 'sha256')
}

export function workspacesRoot(stateRoot: string): string {
  return path.join(stateRoot, 'workspaces')
}

export function workspaceDir(stateRoot: string, workspaceId: string): string {
  return path.join(workspacesRoot(stateRoot), workspaceId)
}

export function sessionsDir(stateRoot: string, workspaceId: string): string {
  return path.join(workspaceDir(stateRoot, workspaceId), 'sessions')
}

export function sessionPath(stateRoot: string, workspaceId: string, sessionId: string): string {
  return path.join(sessionsDir(stateRoot, workspaceId), `${sessionId}.json`)
}

export function manifestsDir(stateRoot: string, workspaceId: string): string {
  return path.join(workspaceDir(stateRoot, workspaceId), 'manifests')
}

export function manifestPath(
  stateRoot: string,
  workspaceId: string,
  manifestId: string,
): string {
  return path.join(manifestsDir(stateRoot, workspaceId), `${manifestId}.json`)
}

export function locksDir(stateRoot: string): string {
  return path.join(stateRoot, 'locks')
}

export function lockPath(stateRoot: string, workspaceId: string): string {
  return path.join(locksDir(stateRoot), `${workspaceId}.lock`)
}

/** mkdir -p for a state subtree. */
export function ensureStateDir(dir: string): void {
  ensureDir(dir)
}
