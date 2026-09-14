import type { Command } from 'commander'
import { AgentCommitError, ErrorCodes, resolveWorkspace, runSession } from '@agentcommit/core'
import { genericAdapter, getAdapter } from '@agentcommit/adapters'
import { terminal } from '../terminal.js'

/** Snapshot → spawn agent (signal forwarding) → post-scan → review session. */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('run an agent command inside a protected session')
    .option('--agent <name>', 'agent identity to record (default: generic)')
    .option('--allow-unprotected', 'explicitly accept listed protection gaps in noninteractive execution')
    .argument('[command...]', 'executable and literal arguments after --; omit to use the registered agent command')
    .action(async (argv: string[], options: { agent?: string; allowUnprotected?: boolean }) => {
      const { root, config } = resolveWorkspace()
      const name = options.agent ?? 'generic'
      const configured = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined
      const adapter = getAdapter(name)
      if (!adapter && !configured) throw new AgentCommitError(ErrorCodes.UnsupportedFile, 'Unknown agent identity; register its command before use.')
      const command = argv.length ? genericAdapter.resolveCommand({}, argv)
        : (adapter ?? genericAdapter).resolveCommand(configured ?? {}, [])
      const abort = new AbortController()
      const interrupt = () => { abort.abort('SIGINT') }
      const terminate = () => { abort.abort('SIGTERM') }
      process.on('SIGINT', interrupt)
      process.on('SIGTERM', terminate)
      try {
        const outcome = await runSession({
          workspaceRoot: root,
          command,
          agent: { kind: name, command: command.command },
          postExitGraceMs: 0,
          signalSource: {
            signal: abort.signal,
            childReceivesConsoleSigint: process.platform === 'win32',
          },
          confirmProtection: async (pre) => {
            console.log(JSON.stringify({ sessionId: pre.session.id, protection: pre.summary, maxFileSizeBytes: pre.manifest.maxFileSizeBytes }))
            console.error('Protection boundary: ignored/unprotected paths cannot be restored. CAS stores plaintext. Background descendants can write after the main process exits; Post has no grace delay. V0.1 does not attribute writes to processes.')
            if (abort.signal.aborted) return false
            if (terminal.interactive) return await terminal.ask('Continue? Type yes: ') === 'yes'
            const hasGaps = pre.summary.unprotectedPaths.length > 0 || pre.summary.ignoredEntries > 0 || pre.summary.unreadableEntries > 0
            if (hasGaps && !options.allowUnprotected) console.error('CONFLICT: use --allow-unprotected only after accepting the listed gaps.')
            return !hasGaps || options.allowUnprotected === true
          },
        })
        console.log(JSON.stringify({ session: outcome.session, exitCode: outcome.exitCode, signal: outcome.signal }))
        process.exitCode = outcome.exitCode ?? (outcome.signal === 'SIGINT' ? 130 : outcome.signal === 'SIGTERM' ? 143 : 1)
      } finally {
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', terminate)
      }
    })
}
