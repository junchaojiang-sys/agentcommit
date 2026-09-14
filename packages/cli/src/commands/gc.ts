import type { Command } from 'commander'
import { notImplemented } from '../not-implemented.js'

/** Reserved cleanup command — disabled in 0.1 alpha (retention decision: OQ-11). */
export function registerGcCommand(program: Command): void {
  program
    .command('gc')
    .description('reserved cleanup command (disabled in 0.1 alpha)')
    .action(() => notImplemented('gc'))
}
