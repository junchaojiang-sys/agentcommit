// Synthetic confirmation transport: production handler, no CLI bypass flag.
import { writeFileSync } from 'node:fs'
import { runRestore } from '../../packages/cli/dist/restore-command.js'
const mode = process.argv[2]
let sessionId
let count = 0
process.exitCode = await runRestore(undefined, true, {
  interactive: true,
  write(text) {
    process.stdout.write(text + '\n')
    try { sessionId ??= JSON.parse(text).sessionId } catch { /* human message */ }
  },
  async ask() {
    count++
    if (mode === 'decline') return 'no'
    if (count === 1) return 'yes'
    if (mode === 'drift') writeFileSync('a-modified.txt', 'edited during Force confirmation')
    return sessionId.slice(-8)
  },
})
