import { existsSync } from 'node:fs'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import {
  WORKSPACE_CONFIG_FILENAME,
  WORKSPACE_IGNORE_FILENAME,
  type WorkspaceConfig,
} from '../config.js'
import { atomicWriteBytes, atomicWriteJson } from './atomic.js'
import { defaultConfig, loadConfig } from './config.js'

export { WORKSPACE_CONFIG_FILENAME, WORKSPACE_IGNORE_FILENAME } from '../config.js'

/** Template written by `init` — every rule commented out, so behavior is unchanged. */
const IGNORE_TEMPLATE = [
  '# AgentCommit ignore rules (gitignore-style patterns, relative to this file).',
  '# This file ONLY controls AgentCommit protection: excluded paths are NOT',
  '# snapshotted and CANNOT be restored by AgentCommit. Choose exclusions carefully —',
  '# unlike .gitignore, this is about data safety, not version control.',
  '#',
  '# Examples:',
  '# tmp/**',
  '# data/large-*.bin',
  '# *.local.log',
  '',
].join('\n')

export interface ResolvedWorkspace {
  /** Canonical workspace root (the directory containing .agentcommit.json). */
  root: string
  configPath: string
  config: WorkspaceConfig
}

/**
 * Frozen discovery (docs/STORAGE.md §9): walk up from startDir to the NEAREST
 * `.agentcommit.json`; that directory is the workspace root (an inner config
 * shadows an outer one). Reaching the filesystem root without a match fails
 * closed with WORKSPACE_NOT_INITIALIZED. AgentCommit never auto-initializes.
 */
export function resolveWorkspace(startDir: string = process.cwd()): ResolvedWorkspace {
  let current = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(current, WORKSPACE_CONFIG_FILENAME)
    if (existsSync(candidate)) {
      return { root: current, configPath: candidate, config: loadConfig(candidate) }
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new AgentCommitError(
        ErrorCodes.WorkspaceNotInitialized,
        `No ${WORKSPACE_CONFIG_FILENAME} found between "${path.resolve(startDir)}" and the filesystem root. Run "agentcommit init" inside your project first.`,
      )
    }
    current = parent
  }
}

/**
 * `agentcommit init` implementation: create workspaceId + config + ignore
 * template. Refuses to touch an existing workspace.
 */
export function initializeWorkspace(startDir: string = process.cwd()): ResolvedWorkspace {
  const root = path.resolve(startDir)
  const configPath = path.join(root, WORKSPACE_CONFIG_FILENAME)
  if (existsSync(configPath)) {
    throw new AgentCommitError(
      ErrorCodes.WorkspaceAlreadyInitialized,
      `This directory is already an AgentCommit workspace: ${configPath}`,
    )
  }
  const config = defaultConfig()
  atomicWriteJson(configPath, config)
  const ignoreFile = path.join(root, WORKSPACE_IGNORE_FILENAME)
  if (!existsSync(ignoreFile)) {
    atomicWriteBytes(ignoreFile, Buffer.from(IGNORE_TEMPLATE, 'utf8'))
  }
  return { root, configPath, config }
}
