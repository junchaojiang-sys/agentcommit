import type { Command } from 'commander'
import { acceptSession } from '@agentcommit/core'
import { context, latestDetails } from '../context.js'

/**
 * Accept the session's changes. Semantics: "accept this AgentCommit session" —
 * it does NOT create a Git commit (docs/PRODUCT.md, OQ-2).
 */
export function registerCommitCommand(program: Command): void {
  program
    .command('commit')
    .description('accept the current session changes (this is not a Git commit)')
    .action(() => {
      const session = acceptSession({ ...context(), sessionId: latestDetails().session.id })
      console.log('AgentCommit transaction accepted.\nThis did NOT create a Git commit.')
      console.log(JSON.stringify(session))
    })
}
