import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initializeWorkspace, listWorkspaceSessions, loadManifest, readLock } from '@agentcommit/core'
import { makeTempDir } from '../helpers.js'

const repo = path.resolve(import.meta.dirname, '../..')
const cli = path.join(repo, 'packages/cli/dist/index.js')
const childScript = path.join(repo, 'tests/fixtures/p3-signal-child.mjs')
const signalHelper = path.join(repo, 'tests/fixtures/send-windows-ctrlc.ps1')
const consoleLauncher = path.join(repo, 'tests/fixtures/start-hidden-console.ps1')

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe.runIf(process.platform === 'win32')('P3 real Windows console signal integration', () => {
  beforeAll(() => {
    for (const name of ['core', 'adapters', 'cli']) {
      execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/${name}/tsconfig.json`], { cwd: repo })
    }
  }, 30_000)

  it('external Ctrl+C reaches the real CLI and child before Post/review and owned-lock release', async () => {
    const temporaryRoot = makeTempDir('agentcommit-p3-real-ctrlc-')
    const workspaceRoot = path.join(temporaryRoot, 'workspace')
    const stateRoot = path.join(temporaryRoot, 'state')
    mkdirSync(workspaceRoot)
    const workspace = initializeWorkspace(workspaceRoot)
    const targetArguments = [cli, 'run', '--', process.execPath, childScript, workspaceRoot]
    const argumentsBase64 = Buffer.from(JSON.stringify(targetArguments), 'utf8').toString('base64')
    const launcher = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', consoleLauncher,
      '-Executable', process.execPath,
      '-WorkingDirectory', workspaceRoot,
      '-ArgumentsBase64', argumentsBase64,
    ], {
      cwd: workspaceRoot,
      env: { ...process.env, AGENTCOMMIT_STATE_DIR: stateRoot },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const targetPid = await new Promise<number>((resolve, reject) => {
      let output = ''
      launcher.stdout.setEncoding('utf8')
      launcher.stdout.on('data', (chunk: string) => {
        output += chunk
        const match = /^PID=(\d+)$/m.exec(output)
        if (match) resolve(Number(match[1]))
      })
      launcher.once('error', reject)
      launcher.once('exit', (code) => reject(new Error(`console launcher exited before reporting PID (${String(code)})`)))
    })
    let launcherError = ''
    launcher.stderr.setEncoding('utf8')
    launcher.stderr.on('data', (chunk: string) => { launcherError += chunk })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      launcher.once('exit', (code, signal) => resolve({ code, signal }))
    })
    let childPid: number | undefined
    try {
      await Promise.race([
        waitForFile(path.join(workspaceRoot, 'signal-ready.json')),
        exited.then((outcome) => { throw new Error(`CLI exited before child readiness (${String(outcome.code)}): ${launcherError}`) }),
      ])
      childPid = JSON.parse(readFileSync(path.join(workspaceRoot, 'signal-ready.json'), 'utf8')).pid as number
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', signalHelper, '-TargetPid', String(targetPid)], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10_000,
      })
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('CLI did not exit after external Ctrl+C')), 15_000))
      const outcome = await Promise.race([exited, timeout])
      expect(outcome.code).toBe(130)
      const ready = JSON.parse(readFileSync(path.join(workspaceRoot, 'signal-ready.json'), 'utf8')) as { pid: number }
      const received = JSON.parse(readFileSync(path.join(workspaceRoot, 'signal-received.json'), 'utf8')) as { signal: string; pid: number }
      expect(received).toEqual({ signal: 'SIGINT', pid: ready.pid })
      const delayedContent = 'written before SIGINT exit'
      expect(readFileSync(path.join(workspaceRoot, 'child-change.txt'), 'utf8')).toBe(delayedContent)
      const sessions = listWorkspaceSessions({ workspaceRoot, stateRoot })
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.status).toBe('review')
      expect(sessions[0]?.postManifestRef).toBeDefined()
      expect(sessions[0]?.changes.map((change) => change.path)).toEqual(expect.arrayContaining([
        'signal-ready.json',
        'signal-received.json',
        'child-change.txt',
      ]))
      const post = loadManifest(stateRoot, workspace.config.workspaceId, sessions[0]!.postManifestRef!)
      const delayedRecord = post.files.find((record) => record.path === 'child-change.txt')
      expect(delayedRecord?.hash).toBe(createHash('sha256').update(delayedContent).digest('hex'))
      expect(readLock(stateRoot, workspace.config.workspaceId)).toEqual({ state: 'absent' })
      const evidence = {
        evidence: 'real-windows-ctrl-c',
        cliPid: targetPid,
        childPid,
        readyPid: ready.pid,
        receivedPid: received.pid,
        receivedSignal: 'SIGINT',
        exitCode: outcome.code,
        sessionStatus: sessions[0]?.status,
        postManifestRef: sessions[0]?.postManifestRef,
        lockState: 'absent',
        delayedChildWriteCaptured: true,
      }
      console.log(JSON.stringify(evidence))
      if (process.env['P3_SIGNAL_EVIDENCE_DIR']) {
        mkdirSync(process.env['P3_SIGNAL_EVIDENCE_DIR'], { recursive: true })
        writeFileSync(path.join(process.env['P3_SIGNAL_EVIDENCE_DIR'], 'real-windows-ctrl-c.json'), JSON.stringify(evidence, null, 2))
        writeFileSync(path.join(process.env['P3_SIGNAL_EVIDENCE_DIR'], 'real-windows-ctrl-c-post.json'), JSON.stringify(post, null, 2))
      }
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) {
        try { launcher.kill('SIGKILL') } catch { /* owned launcher already exited */ }
        try { process.kill(targetPid, 'SIGKILL') } catch { /* owned CLI already exited */ }
        if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch { /* owned child already exited */ } }
      }
    }
  }, 40_000)
})
