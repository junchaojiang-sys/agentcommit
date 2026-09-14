import type { Command } from 'commander'
import { listWorkspaceSessions } from '@agentcommit/core'
import { context } from '../context.js'

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('list past sessions of this workspace')
    .action(() => { console.log(JSON.stringify(listWorkspaceSessions(context()), null, 2)) })
}
