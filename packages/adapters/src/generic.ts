import { spawn } from 'node:child_process'
import type { AdapterConfig, AgentAdapter, CommandSpec, DetectionResult } from './types.js'

const VERSION_TIMEOUT_MS = 3_000
const MAX_VERSION_OUTPUT = 8_192

export function parseCommand(command: string): CommandSpec {
  const parts: string[] = []
  let part = ''
  let quote: '"' | "'" | undefined
  let started = false

  for (const character of command) {
    if (quote) {
      if (character === quote) quote = undefined
      else part += character
      started = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
    } else if (/\s/u.test(character)) {
      if (started) {
        parts.push(part)
        part = ''
        started = false
      }
    } else {
      part += character
      started = true
    }
  }

  if (quote) throw new Error('Command contains an unclosed quote')
  if (started) parts.push(part)
  const [executable, ...args] = parts
  if (!executable) throw new Error('Command executable must not be empty')
  return { command: executable, args }
}

export function resolveConfiguredCommand(
  config: AdapterConfig,
  passthroughArgs: readonly string[],
  defaultCommand?: string,
): CommandSpec {
  if (config.command) {
    const resolved = parseCommand(config.command)
    return { command: resolved.command, args: [...resolved.args, ...passthroughArgs] }
  }
  if (defaultCommand) return { command: defaultCommand, args: [...passthroughArgs] }
  const [command, ...args] = passthroughArgs
  if (!command) throw new Error('An executable or configured command is required')
  return { command, args }
}

export async function detectCommand(
  spec: CommandSpec,
  env: NodeJS.ProcessEnv,
): Promise<DetectionResult> {
  return await new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn(spec.command, [...spec.args, '--version'], {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const finish = (result: DetectionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const capture = (chunk: Buffer): void => {
      if (output.length < MAX_VERSION_OUTPUT) {
        output += chunk.toString('utf8').slice(0, MAX_VERSION_OUTPUT - output.length)
      }
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({ found: false, notes: [`Version probe failed: ${error.code ?? error.message}`] })
    })
    child.once('close', (code) => {
      const version = output.trim().split(/\r?\n/u)[0]
      finish({
        found: true,
        command: spec.command,
        version: code === 0 && version ? version : undefined,
        notes: code === 0 ? undefined : [`Version probe exited with code ${code ?? 'unknown'}`],
      })
    })
    const timeout = setTimeout(() => {
      child.kill()
      finish({ found: false, notes: [`Version probe timed out after ${VERSION_TIMEOUT_MS}ms`] })
    }, VERSION_TIMEOUT_MS)
  })
}

/**
 * The compatibility floor: any local command can be wrapped. Identity-only in
 * Phase 0; detection and spawn land in Phase 3.
 */
export const genericAdapter: AgentAdapter = {
  kind: 'generic',
  displayName: 'Generic CLI',
  async detect(): Promise<DetectionResult> {
    return { found: false, notes: ['Generic adapter detection requires a configured command'] }
  },
  resolveCommand(config: AdapterConfig, passthroughArgs: readonly string[]): CommandSpec {
    return resolveConfiguredCommand(config, passthroughArgs)
  },
}
