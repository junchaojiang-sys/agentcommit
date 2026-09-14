import type { Command } from 'commander'
import { classifyAbandonment, resolveSessionAbandon, resolveStateRoot, resolveWorkspace } from '@agentcommit/core'
import { terminal } from '../terminal.js'

/**
 * P4 crashed-running disposition (user-confirmed D1–D4): `resolve --abandon`
 * terminates tracking of one interrupted running session. Interactive-only with
 * two confirmations; there is no non-interactive bypass. The operator's
 * statement is recorded as a declaration — AgentCommit never claims detached
 * children stopped. Evidence (Session/Manifest/Journal/CAS) is preserved.
 */
export function registerResolveCommand(program: Command): void {
  program
    .command('resolve')
    .description('explicitly resolve a crashed-wrapper session (interactive; evidence preserved)')
    .option('--abandon', 'stop tracking this session; keep all files and evidence (not a commit, not a rollback)')
    .requiredOption('--session <id>', 'full session id (see agentcommit status / history)')
    .action(async (options: { abandon?: boolean; session: string }) => {
      const { root } = resolveWorkspace()
      const stateRoot = resolveStateRoot()
      if (!options.abandon) {
        console.error('USAGE: agentcommit resolve --session <id> --abandon')
        process.exitCode = 2
        return
      }
      if (!terminal.interactive) {
        console.error('CONFLICT: resolve --abandon is interactive-only (two confirmations). Run it in a real terminal.')
        process.exitCode = 2
        return
      }
      const preflight = classifyAbandonment({ workspaceRoot: root, stateRoot, sessionId: options.session })
      if (preflight.session) {
        terminal.write(`Session : ${preflight.session.id}`)
        terminal.write(`Status  : ${preflight.session.status} (started ${preflight.session.startedAt})`)
        terminal.write(`Pre     : ${preflight.session.preManifestRef ? 'present (protected evidence kept)' : 'MISSING'}`)
        terminal.write(`Post    : ${preflight.session.postManifestRef ? 'present' : 'absent (no ChangeSet exists)'}`)
      }
      terminal.write(`Wrapper process : ${
        preflight.pidEvidence === 'proved-dead-local' ? 'PROVEN dead (local lock pid check)'
          : preflight.pidEvidence === 'unverifiable-no-lock-record' ? 'cannot be proven locally (no lock record)'
          : 'state: ' + preflight.pidEvidence}`)
      terminal.write('Children / detached background processes: NOT proven stopped. AgentCommit cannot verify them;')
      terminal.write('  your confirmation below is recorded as YOUR declaration only.')
      if (preflight.refusalReason) terminal.write(`Refusal : ${preflight.refusalReason}`)
      for (const line of preflight.consequences) terminal.write(`  - ${line}`)
      if (!preflight.eligible || preflight.refusalReason) {
        console.error(`CONFLICT: abandon refused. ${preflight.refusalReason ?? ''}`)
        process.exitCode = 2
        return
      }
      const first = await terminal.ask('Confirm the agent task and all its work have stopped (type yes): ')
      if (first !== 'yes') {
        console.error('Abandon cancelled: task-stop confirmation was not given. Nothing was modified.')
        process.exitCode = 2
        return
      }
      const second = await terminal.ask(`Type the full session id to abandon (${preflight.session!.id}): `)
      if (second !== preflight.session!.id) {
        console.error('Abandon cancelled: session id did not match. Nothing was modified.')
        process.exitCode = 2
        return
      }
      const result = await resolveSessionAbandon({
        workspaceRoot: root, stateRoot, sessionId: options.session,
        userDeclaration: { taskStoppedConfirmed: true, confirmedAt: new Date().toISOString() },
      })
      console.log(JSON.stringify({
        resolved: 'abandoned',
        sessionId: result.session.id,
        pidEvidence: result.pidEvidence,
        lockExisted: result.lockExisted,
        lockReleased: result.lockReleased,
        alreadyAbandoned: result.alreadyAbandoned,
        evidencePreserved: true,
        session: result.session,
      }, null, 2))
    })
}
