import type { AdapterConfig, AgentAdapter, CommandSpec, DetectionResult } from './types.js'
import { detectCommand, resolveConfiguredCommand } from './generic.js'

export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  displayName: 'Codex',
  async detect(env: NodeJS.ProcessEnv): Promise<DetectionResult> {
    return await detectCommand({ command: 'codex', args: [] }, env)
  },
  resolveCommand(config: AdapterConfig, passthroughArgs: readonly string[]): CommandSpec {
    return resolveConfiguredCommand(config, passthroughArgs, 'codex')
  },
}
