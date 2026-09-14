import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, fork } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as core from '@agentcommit/core'
import { captureTree, restoreFixture } from '../p2b-helpers.js'

// The real child reads the compiled package; rebuild it once for this test file
// so targeted test runs cannot silently exercise stale dist code.
beforeAll(() => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'packages/core/tsconfig.json'], { cwd: process.cwd(), stdio: 'pipe' })
}, 30_000)

type WorkerResult = { status: string; journalStatus?: string; sessionStatus?: string; eligible?: boolean }

function runChild(inputFile: string, stopAt?: string): Promise<{ pid: number; code: number | null; killedAt?: string; result?: WorkerResult }> {
  return new Promise((resolve, reject) => {
    const child = fork(path.resolve('tests/fixtures/p2b-worker.mjs'), [inputFile, ...(stopAt ? [stopAt] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stderr = ''
    let result: WorkerResult | undefined
    let killedAt: string | undefined
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Child timeout: ${stderr}`)) }, 15_000)
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('message', (message: { event: string; point?: string; result?: WorkerResult; message?: string }) => {
      if (message.event === 'sync-point') {
        killedAt = message.point
        child.kill('SIGKILL')
      }
      if (message.event === 'result') result = message.result
      if (message.event === 'error') stderr += message.message
    })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (stopAt && !killedAt) reject(new Error(`Child never reached ${stopAt}: ${stderr}`))
      else if (!stopAt && !result) reject(new Error(`Child produced no result: ${stderr}`))
      else resolve({ pid: child.pid!, code, killedAt, result })
    })
  })
}

describe('P2-B real process termination recovery', () => {
  it.each(['after-intent', 'temp-write', 'after-replace', 'after-delete', 'after-verified'])('SIGKILL at %s resumes in a fresh Node process', async (point) => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    const inputFile = path.join(f.temporaryRoot, 'worker-input.json')
    writeFileSync(inputFile, JSON.stringify({ workspaceRoot: f.workspaceRoot, stateRoot: f.stateRoot, plan }))
    const first = await runChild(inputFile, point)
    expect(first.killedAt).toBe(point)
    expect(core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)).toBeDefined()
    const second = await runChild(inputFile)
    expect(second.pid).not.toBe(first.pid)
    expect(second.code).toBe(0)
    expect(second.result?.status).toBe('succeeded')
    const inspectFile = path.join(f.temporaryRoot, 'inspect-final.json')
    writeFileSync(inspectFile, JSON.stringify({ workspaceRoot: f.workspaceRoot, stateRoot: f.stateRoot, plan, inspectOnly: true }))
    const third = await runChild(inspectFile)
    expect(third.pid).not.toBe(second.pid)
    expect(third.code).toBe(0)
    expect(third.result).toEqual({ status: 'loaded', journalStatus: 'completed', sessionStatus: 'rolled_back', eligible: true })
    expect(readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'utf8')).toBe(f.original['a-modified.txt'])
    expect(existsSync(path.join(f.workspaceRoot, 'z-created.txt'))).toBe(false)
    console.log(`[P2B-process] point=${point} killedPid=${first.pid} resumedPid=${second.pid} inspectedPid=${third.pid} verified=process-termination-only`)
  }, 25_000)

  it.each(['finish', 'drift', 'missing-journal', 'corrupt-journal'])('SIGKILL between completed Journal and Session finalization: %s', async (scenario) => {
    const f = await restoreFixture()
    const plan = await core.prepareRestore(f)
    await core.executeRestore({ ...f, plan, hooks: { 'after-intent': () => { throw new Error('start retry from rollback_failed') } } })
    const inputFile = path.join(f.temporaryRoot, 'finalization-input.json')
    writeFileSync(inputFile, JSON.stringify({ workspaceRoot: f.workspaceRoot, stateRoot: f.stateRoot, plan }))
    const first = await runChild(inputFile, 'after-journal-completed')
    expect(first.killedAt).toBe('after-journal-completed')
    expect(core.loadRestoreJournal(f.stateRoot, plan.workspaceId, plan.sessionId)?.status).toBe('completed')
    expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).toBe('rollback_failed')
    const journalFile = core.restoreJournalPath(f.stateRoot, plan.workspaceId, plan.sessionId)
    if (scenario === 'drift') writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user edit after completed Journal')
    if (scenario === 'missing-journal') unlinkSync(journalFile)
    if (scenario === 'corrupt-journal') writeFileSync(journalFile, '{broken completed Journal')
    const before = captureTree(f.workspaceRoot)
    const second = await runChild(inputFile)
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    if (scenario === 'finish') {
      expect(second.result?.status).toBe('succeeded')
      const inspectFile = path.join(f.temporaryRoot, 'inspect-finalized.json')
      writeFileSync(inspectFile, JSON.stringify({ workspaceRoot: f.workspaceRoot, stateRoot: f.stateRoot, plan, inspectOnly: true }))
      const third = await runChild(inspectFile)
      expect(third.result).toEqual({ status: 'loaded', journalStatus: 'completed', sessionStatus: 'rolled_back', eligible: true })
      expect(third.pid).not.toBe(second.pid)
      console.log(`[P2B-finalization] killedPid=${first.pid} resumedPid=${second.pid} inspectedPid=${third.pid}`)
    } else {
      expect(second.result?.status).toBe('rejected')
      expect(core.loadSession(f.stateRoot, plan.workspaceId, plan.sessionId).status).toBe('rollback_failed')
      expect(core.sessionAdmission(f.stateRoot, plan.workspaceId).eligible).toBe(false)
    }
  }, 25_000)
})
