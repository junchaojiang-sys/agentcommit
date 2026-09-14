import { randomUUID } from 'node:crypto'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import type { WorkspaceConfig } from '../config.js'
import { atomicWriteJson } from '../storage/atomic.js'
import { resolveWorkspace } from '../storage/discovery.js'
import { acquireLock, readLock, releaseLock } from '../storage/lock.js'
import { loadConfig } from '../storage/config.js'
import { resolveStateRoot } from '../storage/paths.js'
import { sessionAdmission } from '../storage/admission.js'

const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

export interface UpdateAgentRegistrationOptions {
  workspaceRoot: string
  stateRoot?: string
  name: string
  command?: string
}

function validateAgents(agents: WorkspaceConfig['agents']): void {
  for (const [name, value] of Object.entries(agents)) {
    if (!SAFE_AGENT_NAME.test(name) || RESERVED_NAMES.has(name.toLowerCase()) ||
        typeof value !== 'object' || value === null ||
        typeof value.command !== 'string' || value.command.trim() === '') {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Workspace config contains an invalid agent registration.')
    }
  }
}

export function updateAgentRegistration(options: UpdateAgentRegistrationOptions): WorkspaceConfig {
  if (!SAFE_AGENT_NAME.test(options.name) || RESERVED_NAMES.has(options.name.toLowerCase())) {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Agent registration name is not a safe identifier.')
  }
  if (options.command !== undefined && options.command.trim() === '') {
    throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Agent registration command cannot be blank.')
  }
  const initial = resolveWorkspace(options.workspaceRoot)
  const stateRoot = options.stateRoot ?? resolveStateRoot()
  const admission = sessionAdmission(stateRoot, initial.config.workspaceId)
  if (!admission.eligible) {
    throw new AgentCommitError(ErrorCodes.WorkspaceLocked, `Workspace has unfinished Session state: ${admission.blockers.join('; ')}`)
  }
  const operationId = `agent-config-${randomUUID()}`
  const held = acquireLock(stateRoot, {
    workspaceId: initial.config.workspaceId,
    sessionId: operationId,
    agentCommand: '(agent-config)',
  })
  try {
    const current = resolveWorkspace(initial.root)
    if (current.root !== initial.root || current.config.workspaceId !== initial.config.workspaceId) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Workspace identity changed during agent registration.')
    }
    const lockedAdmission = sessionAdmission(stateRoot, current.config.workspaceId)
    if (!lockedAdmission.eligible) {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, `Workspace admission changed during agent registration: ${lockedAdmission.blockers.join('; ')}`)
    }
    const config = loadConfig(current.configPath)
    if (config.workspaceId !== initial.config.workspaceId) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Workspace config binding changed during agent registration.')
    }
    validateAgents(config.agents)
    const agents = Object.fromEntries(Object.entries(config.agents))
    if (options.command === undefined) delete agents[options.name]
    else agents[options.name] = { command: options.command }
    const updated: WorkspaceConfig = { ...config, agents }
    atomicWriteJson(current.configPath, updated)
    const persisted = loadConfig(current.configPath)
    if (JSON.stringify(persisted) !== JSON.stringify(updated)) {
      throw new AgentCommitError(ErrorCodes.StateCorrupt, 'Agent registration could not be verified after persistence.')
    }
    return persisted
  } finally {
    const currentLock = readLock(stateRoot, initial.config.workspaceId)
    if (currentLock.state !== 'readable' || JSON.stringify(currentLock.content) !== JSON.stringify(held)) {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Agent registration lock ownership changed; refusing Session-id-only release.')
    }
    if (!releaseLock(stateRoot, initial.config.workspaceId, operationId)) {
      throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Agent registration lock could not be released.')
    }
  }
}
