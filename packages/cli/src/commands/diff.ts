import type { Command } from 'commander'
import { AgentCommitError, ErrorCodes, FSCasStore, buildProtectionSummary, compareManifests, describeChange } from '@agentcommit/core'
import { context, latestDetails } from '../context.js'

/** Unified text diff for text files; hash/size for binaries. */
export function registerDiffCommand(program: Command): void {
  program
    .command('diff')
    .description('show the session diff (text diff for text files, metadata for binaries)')
    .argument('[path]', 'limit output to one workspace-relative path')
    .action(async (scope?: string) => {
      const { pre, post } = latestDetails()
      if (!pre || !post) throw new AgentCommitError(ErrorCodes.Conflict, 'A complete Pre/Post pair is required for diff.')
      console.log(JSON.stringify({ protection: buildProtectionSummary(post), note: 'Unprotected boundaries cannot be restored.' }))
      const cas = new FSCasStore(context().stateRoot)
      for (const change of compareManifests(pre, post).entries) {
        if (scope && change.path !== scope && !change.path.startsWith(scope + '/')) continue
        const detail = await describeChange(cas, change)
        console.log(detail.patch ?? JSON.stringify({ path: change.path, ...detail }))
      }
    })
}
