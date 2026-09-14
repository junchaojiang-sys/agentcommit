// Invoked only by the synthetic cross-process integration test.
import { readFileSync } from 'node:fs'
import { executeRestore, loadRestoreJournal, loadSession, sessionAdmission } from '../../packages/core/dist/index.js'

const [inputFile, stopAt] = process.argv.slice(2)
const input = JSON.parse(readFileSync(inputFile, 'utf8'))
const hooks = stopAt ? {
  [stopAt]: async () => {
    process.send?.({ event: 'sync-point', point: stopAt })
    await new Promise(() => { setInterval(() => {}, 1000) })
  },
} : undefined
try {
  const result = input.inspectOnly ? {
    status: 'loaded',
    journalStatus: loadRestoreJournal(input.stateRoot, input.plan.workspaceId, input.plan.sessionId)?.status,
    sessionStatus: loadSession(input.stateRoot, input.plan.workspaceId, input.plan.sessionId).status,
    eligible: sessionAdmission(input.stateRoot, input.plan.workspaceId).eligible,
  } : await executeRestore({ ...input, hooks })
  process.send?.({ event: 'result', result })
  process.disconnect?.()
  process.exitCode = result.status === 'succeeded' || result.status === 'loaded' ? 0 : 2
} catch (error) {
  process.send?.({ event: 'error', message: error.message })
  process.disconnect?.()
  process.exitCode = 3
}
