import type { Command } from 'commander'
import { AgentCommitError, ErrorCodes, unlockWorkspace } from '@agentcommit/core'
import { context } from '../context.js'
import { terminal } from '../terminal.js'

/**
 * Remove a workspace lock that the deterministic stale test has proven dead
 * (TRANSACTION_MODEL §3). Requires typing the session id — never automatic.
 */
export function registerUnlockCommand(program: Command): void {
  program
    .command('unlock')
    .description('remove a proven-stale workspace lock (requires session id confirmation)')
    .requiredOption('--session <id>', 'session id holding the lock')
    .action(async (options: { session: string }) => {
      if (!terminal.interactive || await terminal.ask('Type the complete Session id to confirm unlock: ') !== options.session) {
        throw new AgentCommitError(ErrorCodes.WorkspaceLocked, 'Unlock refused: interactive Session confirmation is required.')
      }
      unlockWorkspace({ ...context(), sessionId: options.session })
      console.log('Proven-stale lock removed; Session state was not changed.')
    })
}
