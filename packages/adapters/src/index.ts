import { genericAdapter } from './generic.js'
import { codexAdapter } from './codex.js'
import { claudeAdapter } from './claude.js'
import { zcodeAdapter } from './zcode.js'
import { deepseekAdapter } from './deepseek.js'
import type { AgentAdapter } from './types.js'

export * from './types.js'
export { genericAdapter, parseCommand, resolveConfiguredCommand, detectCommand } from './generic.js'
export { codexAdapter } from './codex.js'
export { claudeAdapter } from './claude.js'
export { zcodeAdapter } from './zcode.js'
export { deepseekAdapter } from './deepseek.js'

const ADAPTERS: readonly AgentAdapter[] = [
  genericAdapter,
  codexAdapter,
  claudeAdapter,
  zcodeAdapter,
  deepseekAdapter,
]

export function listAdapters(): readonly AgentAdapter[] {
  return ADAPTERS
}

export function getAdapter(kind: string): AgentAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.kind === kind)
}
