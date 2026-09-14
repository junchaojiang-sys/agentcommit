import type { AdapterConfig, AgentAdapter, CommandSpec, DetectionResult } from './types.js'
import { detectCommand, resolveConfiguredCommand } from './generic.js'

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  displayName: 'Claude Code',
  async detect(env: NodeJS.ProcessEnv): Promise<DetectionResult> {
    return await detectCommand({ command: 'claude', args: [] }, env)
  },
  resolveCommand(config: AdapterConfig, passthroughArgs: readonly string[]): CommandSpec {
    return resolveConfiguredCommand(config, passthroughArgs, 'claude')
  },
}
