import type { Command } from 'commander'
import { buildProtectionSummary, listWorkspaceSessions } from '@agentcommit/core'
import { context, latestDetails } from '../context.js'

/** Summary of the current/latest session: changes, unprotected warnings, status. */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('show the current or latest session summary')
    .action(() => {
      if (listWorkspaceSessions(context()).length === 0) { console.log('No Session.'); return }
      const { session, pre, post } = latestDetails()
      console.log(JSON.stringify({ session, protection: post || pre ? buildProtectionSummary((post ?? pre)!) : null }, null, 2))
    })
}
