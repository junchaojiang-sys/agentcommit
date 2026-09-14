import { executeRestore, prepareRestore, resolveWorkspace, type RestoreExecutionResult, type RestoreForceAuthorization } from '@agentcommit/core'
import { terminal, type ConfirmationUI } from './terminal.js'

/** No recovery decisions here: every execution uses the plan returned by core for this invocation. */
export async function runRestore(scope: string | undefined, force: boolean, ui: ConfirmationUI = terminal): Promise<number> {
  const { root } = resolveWorkspace()
  const plan = await prepareRestore({ workspaceRoot: root, ...(scope !== undefined ? { scope } : {}) })
  ui.write(JSON.stringify({ sessionId: plan.sessionId, planDigest: plan.planDigest, scope: plan.scope ?? 'whole-session', conflicts: plan.conflicts, blocked: plan.blocked, coverageWarnings: plan.coverageWarnings }))
  let forceAuthorization: RestoreForceAuthorization | undefined
  if (force && plan.conflicts.length) {
    if (!ui.interactive || plan.blocked.length || plan.conflicts.some((conflict) => !conflict.currentFingerprint)) {
      ui.write('CONFLICT: rejected; Force requires an interactive, bound confirmation and cannot bypass blocked paths.')
      return 2
    }
    if ((await ui.ask(`Overwrite the ${plan.conflicts.length} listed conflicting paths for plan ${plan.planDigest}? Type yes: `)) !== 'yes' ||
        (await ui.ask(`Confirm this Session by typing its last 8 characters (${plan.sessionId.slice(-8)}): `)) !== plan.sessionId.slice(-8)) {
      ui.write('CONFLICT: rejected; confirmation declined.')
      return 2
    }
    forceAuthorization = {
      schemaVersion: 1, sessionId: plan.sessionId, planDigest: plan.planDigest,
      conflicts: plan.conflicts.map((conflict) => ({ path: conflict.path, currentFingerprint: conflict.currentFingerprint! })),
    }
  }
  const outcome = await executeRestore({ workspaceRoot: root, plan, ...(forceAuthorization ? { forceAuthorization } : {}) })
  ui.write(JSON.stringify(outcome))
  ui.write(restoreMessage(outcome, scope))
  return outcome.status === 'succeeded' ? 0 : outcome.status === 'rejected' ? 2 : 1
}

export function restoreMessage(outcome: RestoreExecutionResult, scope: string | undefined): string {
  switch (outcome.status) {
    case 'succeeded': return scope === undefined ? 'Whole session restored.' : 'Selected scope restored; the Session remains open for review.'
    case 'partial': return 'RESTORE_PARTIAL: some actions may have taken effect; inspect state and retry this Session.'
    case 'retryable': return 'RESTORE_RETRYABLE: an action may have taken effect before its result was recorded; re-run to re-observe persisted state.'
    case 'rejected': return 'RESTORE_REJECTED: preflight refused; no recovery actions were started by this invocation.'
  }
}
