import type { Command } from 'commander'
import { initializeWorkspace } from '@agentcommit/core'

/** Create the workspace: workspaceId, .agentcommit.json, .agentcommitignore. */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize an AgentCommit workspace in the current directory')
    .action(() => { console.log(JSON.stringify(initializeWorkspace())) })
}
