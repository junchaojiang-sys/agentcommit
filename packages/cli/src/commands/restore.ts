import type { Command } from 'commander'
import { AgentCommitError, ErrorCodes } from '@agentcommit/core'
import { runRestore } from '../restore-command.js'

/** Conflict-checked restore of a single path. */
export function registerRestoreCommand(program: Command): void {
  program
    .command('restore')
    .description('restore a single path from the session snapshot')
    .argument('<path...>', 'workspace-relative path(s) to restore')
    .option('--force', 'overwrite a conflicting path (requires explicit confirmation)')
    .action(async (paths: string[], options: { force?: boolean }) => {
      if (paths.length !== 1) throw new AgentCommitError(ErrorCodes.UnsupportedFile, 'One path scope per invocation is supported by the current core. No paths were restored.')
      process.exitCode = await runRestore(paths[0], options.force ?? false)
    })
}
