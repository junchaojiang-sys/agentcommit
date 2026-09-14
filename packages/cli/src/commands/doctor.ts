import path from 'node:path'
import type { Command } from 'commander'
import { readLock, resolveStateRoot, resolveWorkspace, sessionAdmission } from '@agentcommit/core'
import { buildReport, diagnoseWorkspace, writeDoctorReportExclusively } from '../doctor.js'

/**
 * Read-only environment + state diagnosis (P4).
 *
 * Adds a classified diagnosis (normal / review pending / incomplete restore /
 * interrupted running / unconfirmable lock / Journal-Manifest-CAS anomalies /
 * protection gaps / platform notes) on top of the legacy environment output.
 * The diagnosis itself is strictly read-only. `--report [path]` explicitly
 * creates one new local JSON report file: it never uploads anything, and it
 * refuses to overwrite any existing file/dir/link or to write into protected
 * locations (.git, the state root, the AgentCommit workspace config), including
 * via parent symlink/junction aliases.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('read-only diagnosis of permissions, state directory, sessions, and platform')
    .option('--report [path]', 'explicitly create a new whitelisted, path-anonymized JSON report file (no upload; never overwrites an existing file)')
    .action((options: { report?: string | boolean }) => {
      const { root, config } = resolveWorkspace()
      const stateRoot = resolveStateRoot()
      const result = diagnoseWorkspace({ workspaceRoot: root, stateRoot })
      // Legacy keys stay for compatibility; diagnosis is additive.
      const legacy = {
        node: result.node, platform: result.platform, workspaceRoot: result.workspaceRoot, stateRoot: result.stateRoot,
        lock: readLock(stateRoot, config.workspaceId), admission: sessionAdmission(stateRoot, config.workspaceId),
        boundaries: result.boundaries,
      }
      let reportPath: string | undefined
      let reportError: string | undefined
      if (options.report !== undefined) {
        const requested = typeof options.report === 'string' && options.report.length > 0 ? options.report : undefined
        reportPath = requested ?? `agentcommit-doctor-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
        try {
          writeDoctorReportExclusively(path.resolve(reportPath), JSON.stringify(buildReport(result), null, 2) + '\n', [
            { label: 'state root', p: stateRoot },
            { label: 'git directory', p: path.join(root, '.git') },
            { label: 'workspace config', p: path.join(root, '.agentcommit.json') },
          ])
        } catch (error) {
          // Refuse and fail the command; never fall back to overwriting.
          reportError = `agentcommit doctor: --report refused: ${(error as Error).message}`
          console.error(reportError)
          process.exitCode = 1
        }
      }
      console.log(JSON.stringify({ ...legacy, diagnosis: result.diagnosis, ...(reportPath && !reportError ? { reportPath } : {}) }, null, 2))
    })
}
