#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { AgentCommitError } from '@agentcommit/core'

import { registerAgentCommand } from './commands/agent.js'
import { registerCommitCommand } from './commands/commit.js'
import { registerDiffCommand } from './commands/diff.js'
import { registerDoctorCommand } from './commands/doctor.js'
import { registerGcCommand } from './commands/gc.js'
import { registerHistoryCommand } from './commands/history.js'
import { registerInitCommand } from './commands/init.js'
import { registerPurgeCommand } from './commands/purge.js'
import { registerResolveCommand } from './commands/resolve.js'
import { registerRestoreCommand } from './commands/restore.js'
import { registerRollbackCommand } from './commands/rollback.js'
import { registerRunCommand } from './commands/run.js'
import { registerShowCommand } from './commands/show.js'
import { registerStatusCommand } from './commands/status.js'
import { registerUnlockCommand } from './commands/unlock.js'

export const CLI_VERSION = '0.1.0-alpha.1'

/**
 * The V0.1 command surface, frozen at Phase 0 (normative spec: docs/CLI.md).
 * P3 commands delegate transaction decisions to core.
 */
export function createProgram(): Command {
  const program = new Command()

  program
    .name('agentcommit')
    .description(
      'Transactional safety for AI agents. Preview, commit, and safely roll back agent changes.',
    )
    .version(CLI_VERSION, '--version', 'show version')

  registerInitCommand(program)
  registerRunCommand(program)
  registerStatusCommand(program)
  registerDiffCommand(program)
  registerCommitCommand(program)
  registerRollbackCommand(program)
  registerRestoreCommand(program)
  registerHistoryCommand(program)
  registerShowCommand(program)
  registerDoctorCommand(program)
  registerGcCommand(program)
  registerUnlockCommand(program)
  registerResolveCommand(program)
  registerPurgeCommand(program)
  registerAgentCommand(program)

  return program
}

async function main(): Promise<void> {
  try { await createProgram().parseAsync() } catch (error) {
    console.error(`${error instanceof AgentCommitError ? error.code : 'CLI_ERROR'}: ${(error as Error).message}`)
    process.exitCode = 2
  }
}

/** Execute only when run directly (not when imported by tests/tooling). */
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  await main()
}
