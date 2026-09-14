import type { Command } from 'commander'
import { runRestore } from '../restore-command.js'

/**
 * Deterministic, conflict-checked restore of the whole session.
 * Current != Post ⇒ CONFLICT (refused). --force requires double confirmation.
 */
export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback')
    .description('safely restore the workspace to the session start state')
    .option('--force', 'overwrite conflicting paths (requires explicit confirmation)')
    .action(async (options: { force?: boolean }) => { process.exitCode = await runRestore(undefined, options.force ?? false) })
}
