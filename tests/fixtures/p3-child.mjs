import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [mode, workspaceRoot, ...args] = process.argv.slice(2)

if (mode === 'argv') {
  const [output, exitCode, ...forwarded] = args
  writeFileSync(path.join(workspaceRoot, output), JSON.stringify(forwarded))
  process.exitCode = Number(exitCode)
} else if (mode === 'signal') {
  const [readyFile, output] = args
  process.on('SIGTERM', () => {
    writeFileSync(path.join(workspaceRoot, output), 'SIGTERM')
    process.exit(0)
  })
  process.on('SIGINT', () => {
    writeFileSync(path.join(workspaceRoot, output), 'SIGINT')
    process.exit(0)
  })
  writeFileSync(path.join(workspaceRoot, readyFile), 'ready')
  setInterval(() => {}, 1_000)
} else if (mode === 'replace-lock') {
  const [lockFile, output] = args
  writeFileSync(path.join(workspaceRoot, output), 'child wrote before lock changed')
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  writeFileSync(lockFile, JSON.stringify({ ...lock, pid: 2_147_483_647 }))
} else if (mode === 'replace-workspace-id') {
  const [configFile, output] = args
  writeFileSync(path.join(workspaceRoot, output), 'child wrote before identity changed')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  writeFileSync(configFile, JSON.stringify({ ...config, workspaceId: `${config.workspaceId}-changed` }))
} else {
  throw new Error(`unknown p3 child mode: ${mode}`)
}
