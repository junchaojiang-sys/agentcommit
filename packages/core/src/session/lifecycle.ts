import { spawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { compareManifests } from '../diff/changeset.js'
import { createPostSnapshot } from '../snapshot/post-snapshot.js'
import { createPreSnapshot, type PreSnapshotResult } from '../snapshot/pre-snapshot.js'
import { resolveWorkspace } from '../storage/discovery.js'
import { readLock, releaseLock, type LockContent } from '../storage/lock.js'
import { resolveStateRoot } from '../storage/paths.js'
import { ensureDir } from '../storage/atomic.js'
import { loadSession, persistSession } from '../storage/session-store.js'
import { sessionAdmission } from '../storage/admission.js'
import { SessionStatus, type AgentInfo, type Session } from './types.js'

export interface RunSessionOptions {
  workspaceRoot: string
  stateRoot?: string
  command: { command: string; args: string[] }
  agent: AgentInfo
  confirmProtection: (pre: PreSnapshotResult) => Promise<boolean>
  postExitGraceMs?: number
  signalSource?: AbortSignal | {
    signal: AbortSignal
    /** Windows console Ctrl+C is delivered to the already-running child too. */
    childReceivesConsoleSigint: boolean
  }
}

export interface RunSessionResult {
  session: Session
  exitCode: number | null
  signal: NodeJS.Signals | null
}

interface RootIdentity {
  workspaceRoot: string
  workspaceId: string
  realPath: string
  device: number
  inode: number
}

function captureIdentity(workspaceRoot: string, workspaceId: string): RootIdentity {
  const stat = lstatSync(workspaceRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Workspace root must be a real directory, not a link or unsupported type.')
  }
  return {
    workspaceRoot,
    workspaceId,
    realPath: realpathSync.native(workspaceRoot),
    device: stat.dev,
    inode: stat.ino,
  }
}

function assertExternalStateRoot(workspaceRoot: string, stateRoot: string): void {
  const lexical = pathRelation(workspaceRoot, stateRoot)
  if (lexical === 'same-or-child') {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'State root must be outside the protected workspace.')
  }
  ensureDir(stateRoot)
  const physical = pathRelation(realpathSync.native(workspaceRoot), realpathSync.native(stateRoot))
  if (physical === 'same-or-child') {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'State root resolves inside the protected workspace.')
  }
}

function pathRelation(parent: string, candidate: string): 'same-or-child' | 'outside' {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    ? 'same-or-child'
    : 'outside'
}

function assertIdentity(identity: RootIdentity): void {
  const { workspaceRoot, workspaceId } = identity
  const current = resolveWorkspace(workspaceRoot)
  const stat = lstatSync(workspaceRoot)
  if (current.root !== workspaceRoot || current.config.workspaceId !== workspaceId ||
      realpathSync.native(workspaceRoot) !== identity.realPath ||
      stat.dev !== identity.device || stat.ino !== identity.inode) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Workspace root or identity changed during the Session.')
  }
}

function assertOwnedLock(stateRoot: string, workspaceId: string, held: LockContent): void {
  const current = readLock(stateRoot, workspaceId)
  if (current.state !== 'readable' || current.content.pid !== process.pid ||
      current.content.hostname !== held.hostname || current.content.workspaceId !== workspaceId ||
      current.content.sessionId !== held.sessionId || JSON.stringify(current.content) !== JSON.stringify(held)) {
    throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Session lock ownership changed or cannot be proven.')
  }
}

function abortSignal(reason: unknown): NodeJS.Signals {
  return reason === 'SIGINT' || reason === 'SIGTERM' ? reason : 'SIGTERM'
}

function signalSource(options: RunSessionOptions): { signal?: AbortSignal; childReceivesConsoleSigint: boolean } {
  if (!options.signalSource) return { childReceivesConsoleSigint: false }
  if ('signal' in options.signalSource) return options.signalSource
  return { signal: options.signalSource, childReceivesConsoleSigint: false }
}

function executeChild(
  options: RunSessionOptions,
  onSpawn: () => void,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command.command, options.command.args, {
      cwd: options.workspaceRoot,
      shell: false,
      stdio: 'inherit',
    })
    let spawned = false
    let forwarded: NodeJS.Signals | null = null
    let requiresExplicitForward = false
    const source = signalSource(options)
    const onAbort = () => {
      forwarded = abortSignal(source.signal?.reason)
      requiresExplicitForward = !spawned || forwarded !== 'SIGINT' || !source.childReceivesConsoleSigint
      if (spawned && requiresExplicitForward) child.kill(forwarded)
    }
    source.signal?.addEventListener('abort', onAbort, { once: true })
    if (source.signal?.aborted) onAbort()
    child.once('spawn', () => {
      spawned = true
      onSpawn()
      if (forwarded && requiresExplicitForward) child.kill(forwarded)
    })
    child.once('error', (error) => {
      if (!spawned) {
        source.signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    })
    child.once('close', (exitCode, signal) => {
      source.signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode: forwarded === null ? exitCode : null,
        signal: forwarded ?? signal,
      })
    })
  })
}

export async function runSession(options: RunSessionOptions): Promise<RunSessionResult> {
  if (options.agent.command !== options.command.command || options.command.command.trim() === '' ||
      !Array.isArray(options.command.args) || options.command.args.some((arg) => typeof arg !== 'string')) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Agent identity command does not match the executable and argv contract.')
  }
  if (options.postExitGraceMs !== undefined && (!Number.isFinite(options.postExitGraceMs) || options.postExitGraceMs < 0)) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'postExitGraceMs must be a finite non-negative number.')
  }
  const resolved = resolveWorkspace(options.workspaceRoot)
  const workspaceRoot = resolved.root
  const workspaceId = resolved.config.workspaceId
  const identity = captureIdentity(workspaceRoot, workspaceId)
  const stateRoot = options.stateRoot ?? resolveStateRoot()
  assertExternalStateRoot(workspaceRoot, stateRoot)
  const admission = sessionAdmission(stateRoot, workspaceId)
  if (!admission.eligible) {
    throw new AgentCommitError(
      ErrorCodes.WorkspaceLocked,
      `Workspace has unfinished Session state: ${admission.blockers.join('; ')}`,
    )
  }
  let session: Session | undefined
  let held: LockContent | undefined
  let primaryError: unknown
  let childStarted = false
  try {
    const pre = await createPreSnapshot({
      workspaceRoot,
      stateRoot,
      agent: options.agent,
      retainLockOnSuccess: true,
    })
    session = pre.session
    const lock = readLock(stateRoot, workspaceId)
    if (lock.state !== 'readable') {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Retained Session lock cannot be verified.')
    }
    held = lock.content
    assertOwnedLock(stateRoot, workspaceId, held)
    assertIdentity(identity)
    const ownedAdmission = sessionAdmission(stateRoot, workspaceId, { excludeSessionId: session.id })
    if (!ownedAdmission.eligible) {
      throw new AgentCommitError(
        ErrorCodes.WorkspaceLocked,
        `Workspace admission changed before execution: ${ownedAdmission.blockers.join('; ')}`,
      )
    }
    if (!(await options.confirmProtection(pre))) {
      throw new AgentCommitError(ErrorCodes.Conflict, 'Protection confirmation was declined.')
    }
    assertOwnedLock(stateRoot, workspaceId, held)
    assertIdentity(identity)
    session = { ...session, status: SessionStatus.Running }
    persistSession(stateRoot, workspaceId, session)

    const child = await executeChild({ ...options, workspaceRoot }, () => { childStarted = true })
    assertOwnedLock(stateRoot, workspaceId, held)
    assertIdentity(identity)
    const graceMs = options.postExitGraceMs ?? 0
    if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs))
    assertOwnedLock(stateRoot, workspaceId, held)
    assertIdentity(identity)
    const post = await createPostSnapshot({ workspaceRoot, stateRoot, sessionId: session.id })
    assertOwnedLock(stateRoot, workspaceId, held)
    assertIdentity(identity)
    const changes = compareManifests(post.preManifest, post.postManifest).entries
    session = {
      ...post.session,
      changes,
      verification: { exitCode: child.exitCode, checks: ['post-scan', 'change-set'] },
      endedAt: new Date().toISOString(),
    }
    persistSession(stateRoot, workspaceId, session)
    return { session, exitCode: child.exitCode, signal: child.signal }
  } catch (error) {
    primaryError = error
    if (session) {
      try {
        const current = loadSession(stateRoot, workspaceId, session.id)
        if (current.status === SessionStatus.Review) {
          session = current
        } else if (childStarted) {
          const { endedAt: _endedAt, postManifestRef: _postManifestRef, ...running } = current
          session = { ...running, status: SessionStatus.Running }
          persistSession(stateRoot, workspaceId, session)
        } else {
          session = { ...current, status: SessionStatus.Failed, endedAt: new Date().toISOString() }
          persistSession(stateRoot, workspaceId, session)
        }
      } catch {
        // Fail closed: retain and report the original lifecycle failure.
      }
    }
    throw error
  } finally {
    if (held) {
      try {
        assertOwnedLock(stateRoot, workspaceId, held)
        assertIdentity(identity)
        if (!releaseLock(stateRoot, workspaceId, held.sessionId)) {
          throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Owned Session lock could not be released.')
        }
      } catch (releaseError) {
        if (primaryError === undefined) throw releaseError
      }
    }
  }
}
