import type { AdapterConfig, AgentAdapter, CommandSpec, DetectionResult } from './types.js'
import { resolveConfiguredCommand } from './generic.js'

/**
 * No fixed executable name is hardcoded anywhere: the default launch command is
 * auto-detected in Phase 3, and the user can always override it via
 * `agentcommit agent add zcode --command "..."`.
 */
export const zcodeAdapter: AgentAdapter = {
  kind: 'zcode',
  displayName: 'Z Code',
  async detect(): Promise<DetectionResult> {
    return { found: false, notes: ['Z Code detection requires a configured command'] }
  },
  resolveCommand(config: AdapterConfig, passthroughArgs: readonly string[]): CommandSpec {
    if (!config.command) throw new Error('Z Code requires a configured command')
    return resolveConfiguredCommand(config, passthroughArgs)
  },
}
