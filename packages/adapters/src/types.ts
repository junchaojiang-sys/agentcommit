/**
 * Agent adapter contract. Adapters provide identity, detection, and command
 * resolution ONLY — every protection capability lives in @agentcommit/core
 * behind the generic command wrapper (docs/ARCHITECTURE.md §5).
 */

export interface DetectionResult {
  /** Whether the agent's launch command was found on this machine. */
  found: boolean
  /** Resolved command when found. */
  command?: string
  /** Agent version when detectable. */
  version?: string
  /** Non-fatal observations (e.g. 'command found on PATH at ...'). */
  notes?: string[]
}

/** Per-agent configuration stored in .agentcommit.json (user-overridable). */
export interface AdapterConfig {
  /**
   * Launch command configured via `agentcommit agent add <name> --command "..."`.
   * Always user-overridable — adapter defaults are conveniences, never contracts.
   */
  command?: string
}

/** A fully resolved launch specification for spawning the agent process. */
export interface CommandSpec {
  command: string
  args: string[]
}

export interface AgentAdapter {
  /** Stable identity: 'codex' | 'claude' | 'zcode' | 'deepseek' | 'generic'. */
  kind: string
  /** Human-readable name for review output. */
  displayName: string
  detect(env: NodeJS.ProcessEnv): Promise<DetectionResult>
  resolveCommand(config: AdapterConfig, passthroughArgs: readonly string[]): CommandSpec
  /** Optional version/environment metadata collection (Phase 3). */
  collectMetadata?(pid: number): Promise<Record<string, unknown>>
}
