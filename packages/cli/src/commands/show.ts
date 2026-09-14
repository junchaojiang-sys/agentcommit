import type { Command } from 'commander'
import { latestDetails } from '../context.js'

export function registerShowCommand(program: Command): void {
  program
    .command('show')
    .description('show details of one historical session')
    .argument('<id>', 'session id')
    .action((id: string) => { console.log(JSON.stringify(latestDetails(id), null, 2)) })
}
