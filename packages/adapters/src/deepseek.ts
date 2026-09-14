import type { AdapterConfig, AgentAdapter, CommandSpec, DetectionResult } from './types.js'
import { resolveConfiguredCommand } from './generic.js'

/**
 * DeepSeek is first-class in the V0.1 support matrix but never bound to one
 * specific client: DeepSeek CLI, harnesses, and custom launchers all resolve
 * through the user-configurable command spec. AgentCommit never calls the
 * DeepSeek API and never stores API keys.
 */
export const deepseekAdapter: AgentAdapter = {
  kind: 'deepseek',
  displayName: 'DeepSeek',
  async detect(): Promise<DetectionResult> {
    return { found: false, notes: ['DeepSeek detection requires a configured command'] }
  },
  resolveCommand(config: AdapterConfig, passthroughArgs: readonly string[]): CommandSpec {
    if (!config.command) throw new Error('DeepSeek requires a configured command')
    return resolveConfiguredCommand(config, passthroughArgs)
  },
}
