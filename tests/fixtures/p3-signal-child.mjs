import { writeFileSync } from 'node:fs'
import path from 'node:path'

const [workspaceRoot] = process.argv.slice(2)
const write = (name, value) => writeFileSync(path.join(workspaceRoot, name), value)

process.on('SIGINT', () => {
  write('signal-received.json', JSON.stringify({ signal: 'SIGINT', pid: process.pid }))
  setTimeout(() => {
    write('child-change.txt', 'written before SIGINT exit')
    process.exit(0)
  }, 150)
})
process.on('SIGTERM', () => {
  write('signal-received.json', JSON.stringify({ signal: 'SIGTERM', pid: process.pid }))
  setTimeout(() => {
    write('child-change.txt', 'written before SIGTERM exit')
    process.exit(0)
  }, 150)
})

write('signal-ready.json', JSON.stringify({ pid: process.pid }))
setInterval(() => {}, 1_000)
