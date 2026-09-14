import { AgentCommitError, ErrorCodes } from '../errors.js'
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  WORKSPACE_CONFIG_VERSION,
  type WorkspaceConfig,
} from '../config.js'
import { readJson } from './atomic.js'

/** Validate an untrusted parsed config; throws STATE_CORRUPT on any deviation. */
export function parseConfig(raw: unknown, configPath: string): WorkspaceConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Workspace config is not an object: ${configPath}`,
    )
  }
  const value = raw as Record<string, unknown>
  if (value['version'] !== WORKSPACE_CONFIG_VERSION) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Unsupported workspace config version ${String(value['version'])} (expected ${WORKSPACE_CONFIG_VERSION}): ${configPath}`,
    )
  }
  const workspaceId = value['workspaceId']
  if (typeof workspaceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workspaceId)) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Workspace config has an invalid workspaceId: ${configPath}`,
    )
  }
  const agents = value['agents']
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Workspace config has an invalid agents map: ${configPath}`,
    )
  }
  const maxFileSizeBytes = value['maxFileSizeBytes']
  if (
    typeof maxFileSizeBytes !== 'number' ||
    !Number.isInteger(maxFileSizeBytes) ||
    maxFileSizeBytes <= 0
  ) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Workspace config has an invalid maxFileSizeBytes: ${configPath}`,
    )
  }
  return {
    version: WORKSPACE_CONFIG_VERSION,
    workspaceId,
    agents: agents as WorkspaceConfig['agents'],
    maxFileSizeBytes,
  }
}

/** Load + validate `.agentcommit.json`. JSON/schema errors become STATE_CORRUPT. */
export function loadConfig(configPath: string): WorkspaceConfig {
  let raw: unknown
  try {
    raw = readJson(configPath)
  } catch (error) {
    throw new AgentCommitError(
      ErrorCodes.StateCorrupt,
      `Workspace config is not valid JSON: ${configPath}`,
      { cause: error },
    )
  }
  return parseConfig(raw, configPath)
}

/** Default config for `agentcommit init`. */
export function defaultConfig(): WorkspaceConfig {
  return {
    version: WORKSPACE_CONFIG_VERSION,
    workspaceId: crypto.randomUUID(),
    agents: {},
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
  }
}
