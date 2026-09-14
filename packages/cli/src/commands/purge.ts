import type { Command } from 'commander'
import { notImplemented } from '../not-implemented.js'

/** Reserved full-cleanup command — disabled in 0.1 alpha; performs no deletion. */
export function registerPurgeCommand(program: Command): void {
  program
    .command('purge')
    .description('reserved full-cleanup command (disabled in 0.1 alpha)')
    .action(() => notImplemented('purge'))
}
