import type { Command } from 'commander'
import { resolveWorkspace, updateAgentRegistration } from '@agentcommit/core'
import { parseCommand } from '@agentcommit/adapters'
import { context } from '../context.js'

/**
 * Registry of named agent launch commands (plan §3.1). Names map to
 * user-configurable commands in .agentcommit.json; nothing is hardcoded.
 */
export function registerAgentCommand(program: Command): void {
  const agent = program
    .command('agent')
    .description('manage registered agent launch commands')

  agent
    .command('add')
    .description('register an agent launch command')
    .argument('<name>', 'agent name (e.g. deepseek, zcode, deepseek-local)')
    .requiredOption('--command <command>', 'launch command for this agent')
    .action((name: string, options: { command: string }) => {
      parseCommand(options.command)
      updateAgentRegistration({ ...context(), name, command: options.command })
      console.log(`Registered ${name}. This records a command; it does not verify a real Agent integration.`)
    })

  agent
    .command('list')
    .description('list registered agents')
    .action(() => { console.log(JSON.stringify(resolveWorkspace().config.agents, null, 2)) })

  agent
    .command('remove')
    .description('remove a registered agent')
    .argument('<name>', 'agent name to remove')
    .action((name: string) => { updateAgentRegistration({ ...context(), name }); console.log(`Removed ${name}.`) })
}
