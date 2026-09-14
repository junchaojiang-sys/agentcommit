// P4 synthetic CLI end-to-end flow for CI (and local equivalents).
// Synthetic Node children stand in for agents; no model accounts, no secrets,
// no user state. Verifies: init → run → status/diff/commit; failing child →
// review → rollback restores; hard-killed wrapper (SIGKILL on this test's own
// process) → new runs refuse. Crashed-run disposition beyond refusal is NOT
// verified here.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '../..')
const cli = path.join(repo, 'packages/cli/dist/index.js')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'agentcommit-ci-flow-'))
const ws = path.join(tmp, 'ws')
const stateRoot = path.join(tmp, 'state')
mkdirSync(ws, { recursive: true })
const env = { ...process.env, AGENTCOMMIT_STATE_DIR: stateRoot }

let failures = 0
async function step(name, fn) {
  try {
    await fn()
    console.log(`[ok] ${name}`)
  } catch (error) {
    failures++
    console.error(`[FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function invoke(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: ws, env, encoding: 'utf8', timeout: 60_000, ...options })
}
function expectStatus(result, expected, label) {
  if (result.status !== expected) throw new Error(`${label}: exit ${result.status} (want ${expected}) stderr=${result.stderr?.slice(0, 300)}`)
}
const read = name => readFileSync(path.join(ws, name), 'utf8')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// Confirm a pid is gone ONLY via ESRCH (POSIX) or an equivalent non-killing
// existence check. On Windows, signal 0 on a dead pid can surface EPERM for a
// pid-reuse race; tasklist is a read-only query that resolves that ambiguity.
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM' && process.platform === 'win32') {
      const query = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10_000 })
      return query.stdout?.includes(`"${pid}"`)
    }
    throw error
  }
}

await step('init', () => expectStatus(invoke(['init']), 0, 'init'))
writeFileSync(path.join(ws, 'hello.txt'), 'before\n')

await step('run synthetic agent (edit, exit 0)', () => {
  expectStatus(invoke(['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('hello.txt','after\\n')"]), 0, 'run')
})
await step('status shows review', () => {
  const status = invoke(['status'])
  expectStatus(status, 0, 'status')
  if (!status.stdout.includes('"review"')) throw new Error('status did not show review')
})
await step('diff lists the change', () => {
  expectStatus(invoke(['diff', 'hello.txt']), 0, 'diff')
})
await step('commit accepts the session', () => {
  expectStatus(invoke(['commit']), 0, 'commit')
  if (!read('hello.txt').includes('after')) throw new Error('committed content missing')
})

await step('run failing synthetic agent (exit 7) still reaches review', () => {
  writeFileSync(path.join(ws, 'hello.txt'), 'torn\n')
  expectStatus(invoke(['run', '--allow-unprotected', '--', process.execPath, '-e', "require('node:fs').writeFileSync('hello.txt','agent\\n');process.exitCode=7"]), 7, 'run(fail)')
})
await step('rollback restores and closes the session', () => {
  expectStatus(invoke(['rollback']), 0, 'rollback')
  if (read('hello.txt') !== 'torn\n') throw new Error('rollback did not restore pre content')
})

let keepTempRoot = false
await step('hard-killed wrapper (SIGKILL) leaves running state with no Post; new runs refuse (crashed-run handling not verified beyond refusal)', async () => {
  // Handshake (same technique as tests/integration/p3-cli.test.ts): the
  // synthetic child proves it is running by writing a unique ready marker
  // inside this test's temp root, then stays alive with no further writes so
  // cleanup is deterministic.
  const marker = path.join(ws, 'child-ready.json')
  const unsafe = path.join(ws, 'unsafe-new-run.txt')
  const childCode = `require('node:fs').writeFileSync('child-ready.json', JSON.stringify({pid:process.pid})); setTimeout(()=>{},30000)`
  const wrapper = spawn(process.execPath, [cli, 'run', '--allow-unprotected', '--', process.execPath, '-e', childCode], {
    cwd: ws, env, stdio: 'ignore',
  })
  // Bounded: resolve on exit OR spawn error OR timeout, never hang forever.
  const wrapperExited = new Promise(resolve => {
    wrapper.once('exit', () => resolve('exit'))
    wrapper.once('error', error => resolve(`spawn error: ${error?.message ?? error}`))
  })
  let childPid
  try {
    const deadline = Date.now() + 20_000
    // Wait for the marker to contain COMPLETE JSON with a plausible pid — the
    // file may be observed mid-write right after creation.
    while (true) {
      let ready = null
      if (existsSync(marker)) {
        try { ready = JSON.parse(readFileSync(marker, 'utf8')) } catch { /* incomplete write, keep polling */ }
      }
      if (ready && Number.isInteger(ready.pid) && ready.pid > 0) { childPid = ready.pid; break }
      if (Date.now() > deadline) throw new Error('synthetic child never reported a ready marker with a valid pid; no evidence it started, refusing to "kill" blind')
      await sleep(20)
    }
    // Hard-kill ONLY the wrapper this test spawned: SIGKILL on POSIX,
    // TerminateProcess via Node's kill on Windows. This bypasses the CLI's
    // SIGTERM graceful path — a true hard kill, not a graceful shutdown.
    wrapper.kill('SIGKILL')
    const wrapperOutcome = await Promise.race([wrapperExited, sleep(10_000).then(() => 'timeout')])
    if (wrapperOutcome !== 'exit') throw new Error(`wrapper did not exit after SIGKILL (${wrapperOutcome})`)

    const status = invoke(['status'])
    expectStatus(status, 0, 'status(after kill)')
    const session = JSON.parse(status.stdout).session
    if (session.status !== 'running') throw new Error(`session status ${session.status} (want running: no Post/review ran after the hard kill)`)
    if (!session.preManifestRef) throw new Error('session has no preManifestRef (Pre must have run before the hard kill)')
    if (session.postManifestRef !== undefined && session.postManifestRef !== null) throw new Error(`session postManifestRef = ${JSON.stringify(session.postManifestRef)} (want absent: Post never ran)`)

    const refused = invoke(['run', '--allow-unprotected', '--', process.execPath, '-e', `require('node:fs').writeFileSync('unsafe-new-run.txt','x')`])
    if (refused.status !== 2) throw new Error(`new run after hard kill exited ${refused.status} (want 2 refused)`)
    if (existsSync(unsafe)) throw new Error('refused new run still let its child write a target file')

    const doctor = invoke(['doctor', '--report', path.join(tmp, 'doctor.json')])
    expectStatus(doctor, 0, 'doctor')
    if (!doctor.stdout.includes('session-running')) throw new Error('doctor did not classify the interrupted running session')
    console.log(JSON.stringify({ evidence: 'ci-hard-kill', wrapperPid: wrapper.pid, childPid, persistedStatus: session.status, preManifestRef: session.preManifestRef, postManifestRef: session.postManifestRef ?? null, subsequentRunExit: refused.status }))
  } finally {
    // Cleanup of only the processes this test owns, by pid — never by name and
    // never with wider privileges. The temp root is removed only after the
    // synthetic child is CONFIRMED gone (ESRCH or equivalent); if it is still
    // alive or its state cannot be confirmed, fail the whole script and keep
    // the temp root for inspection.
    try { wrapper.kill('SIGKILL') } catch { /* already exited */ }
    if (childPid) {
      try { process.kill(childPid, 'SIGKILL') } catch { /* may already be gone; the poll below decides */ }
      const gone = Date.now() + 10_000
      let confirmedDead = false
      while (Date.now() < gone) {
        let alive
        try { alive = pidAlive(childPid) } catch { break }
        if (!alive) { confirmedDead = true; break }
        await sleep(20)
      }
      if (!confirmedDead) {
        keepTempRoot = true
        throw new Error(`cleanup could not confirm synthetic child pid ${childPid} was gone (still alive or unverifiable); keeping temp root ${tmp} for inspection`)
      }
    }
    await Promise.race([wrapperExited, sleep(10_000)])
  }
})

if (keepTempRoot) {
  console.error(`synthetic flow: cleanup could not confirm child exit; temp root kept at ${tmp}`)
  process.exit(1)
}
rmSync(tmp, { recursive: true, force: true })
if (failures > 0) {
  console.error(`synthetic flow: ${failures} step(s) failed`)
  process.exit(1)
}
console.log('synthetic flow: all steps ok')
