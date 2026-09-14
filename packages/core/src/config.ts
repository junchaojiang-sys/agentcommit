/**
 * Frozen V0.1 defaults. Sources: docs/STORAGE.md §4–5, docs/PRODUCT.md §6.
 * Changing any of these constants is a product decision requiring user approval.
 */

/** Per-file protection cap (plan §7.4). Files above are metadata-only + warned. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024

/**
 * Default exclusions. Deliberately NOT a blanket .gitignore inheritance:
 * git-ignored .env/private configs are often exactly what needs protecting
 * (plan §7.3).
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.git/**',
  '.agentcommit/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  '.next/**',
  'coverage/**',
  '.venv/**',
  'venv/**',
  '__pycache__/**',
  'target/**',
  '*.tmp',
  '*.cache',
]

/** Project-local config file created by `agentcommit init`. */
export const WORKSPACE_CONFIG_FILENAME = '.agentcommit.json'

/** Project-local user exclusions. */
export const WORKSPACE_IGNORE_FILENAME = '.agentcommitignore'

/** Adapter kinds shipped with V0.1; 'generic' is the compatibility floor. */
export const AGENT_KINDS = ['generic', 'codex', 'claude', 'zcode', 'deepseek'] as const

export type AgentKind = (typeof AGENT_KINDS)[number]

/** Schema version of .agentcommit.json. Bumping requires a migration story. */
export const WORKSPACE_CONFIG_VERSION = 1

/** Registered launch command for a named agent (user-configurable). */
export interface AgentCommandConfig {
  command: string
}

/** Contents of .agentcommit.json. */
export interface WorkspaceConfig {
  version: typeof WORKSPACE_CONFIG_VERSION
  workspaceId: string
  agents: Record<string, AgentCommandConfig>
  maxFileSizeBytes: number
}
