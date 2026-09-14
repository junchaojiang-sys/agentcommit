import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { executeRestore, initializeWorkspace, loadRestoreJournal, loadSession, prepareRestore, sessionAdmission } from '@agentcommit/core'
import { captureTree, restoreFixture } from '../p2b-helpers.js'
import { makeTempDir } from '../helpers.js'

const repo = path.resolve(import.meta.dirname, '../..')
const cli = path.join(repo, 'packages/cli/dist/index.js')
beforeAll(() => {
  for (const name of ['core', 'adapters', 'cli']) {
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/${name}/tsconfig.json`], { cwd: repo })
  }
}, 30_000)

function invoke(workspaceRoot: string, stateRoot: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: workspaceRoot, env: { ...process.env, AGENTCOMMIT_STATE_DIR: stateRoot }, encoding: 'utf8', timeout: 15_000,
  })
}

describe('P3 CLI core integration', () => {
  it('a refused rollback with no action intents still permits explicit acceptance of the review Session', async () => {
    const f = await restoreFixture()
    writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user accepts this edit')
    expect(invoke(f.workspaceRoot, f.stateRoot, ['rollback']).status).toBe(2)
    const planned = loadRestoreJournal(f.stateRoot, f.pre.session.workspaceId, f.pre.session.id)!
    expect(planned.status).toBe('prepared')
    expect(planned.attempts).toEqual([])
    const before = captureTree(f.workspaceRoot)
    const accepted = invoke(f.workspaceRoot, f.stateRoot, ['commit'])
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(captureTree(f.workspaceRoot)).toEqual(before)
    expect(loadSession(f.stateRoot, f.pre.session.workspaceId, f.pre.session.id).status).toBe('committed')
    expect(sessionAdmission(f.stateRoot, f.pre.session.workspaceId).eligible).toBe(true)
  })

  // 5s default timed out under full-suite parallel load; 30s leaves ample headroom
  // for 6 CLI subprocess spawns x2 identities (flake fix: wait budget only).
  it('registered Z Code and DeepSeek identities share the Generic Wrapper using configured executables', { timeout: 30_000 }, () => {
    const temp = makeTempDir('agentcommit-p3-configured-')
    const root = path.join(temp, 'workspace')
    const state = path.join(temp, 'state')
    mkdirSync(root)
    initializeWorkspace(root)
    const script = path.join(temp, 'synthetic agent.mjs')
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync('agent-output.txt', process.argv.slice(2).join('|'))`)
    for (const name of ['zcode', 'deepseek']) {
      const command = `"${process.execPath}" "${script}" "中文 ; $literal"`
      const added = invoke(root, state, ['agent', 'add', name, '--command', command])
      expect(added.status, added.stderr).toBe(0)
      expect(invoke(root, state, ['agent', 'list']).stdout).toContain(name)
      const run = invoke(root, state, ['run', '--agent', name])
      expect(run.status, run.stderr).toBe(0)
      expect(readFileSync(path.join(root, 'agent-output.txt'), 'utf8')).toBe('中文 ; $literal')
      expect(JSON.parse(invoke(root, state, ['status']).stdout).session.agent.kind).toBe(name)
      expect(invoke(root, state, ['commit']).status).toBe(0)
      expect(invoke(root, state, ['agent', 'remove', name]).status).toBe(0)
    }
  })

  it('multiple scopes and deferred cleanup commands refuse without touching the workspace', async () => {
    const f = await restoreFixture()
    const before = captureTree(f.workspaceRoot)
    for (const args of [['restore', 'a-modified.txt', 'outside-scope.txt'], ['gc'], ['purge']]) {
      expect(invoke(f.workspaceRoot, f.stateRoot, args).status).toBe(2)
      expect(captureTree(f.workspaceRoot)).toEqual(before)
    }
  })

  it('hard-killed Wrapper leaves persisted running state and a fresh CLI refuses another run while its child may still live', async () => {
    const temp = makeTempDir('agentcommit-p3-kill-')
    const root = path.join(temp, 'workspace')
    const state = path.join(temp, 'state')
    mkdirSync(root)
    initializeWorkspace(root)
    const marker = path.join(root, 'child-started.json')
    const childCode = `require('node:fs').writeFileSync('child-started.json', JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)`
    const wrapper = spawn(process.execPath, [cli, 'run', '--', process.execPath, '-e', childCode], {
      cwd: root, env: { ...process.env, AGENTCOMMIT_STATE_DIR: state }, stdio: 'ignore',
    })
    const exited = new Promise<void>((resolve) => { wrapper.once('exit', () => resolve()) })
    let childPid: number | undefined
    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error('synthetic child did not start')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      childPid = JSON.parse(readFileSync(marker, 'utf8')).pid as number
      wrapper.kill('SIGKILL')
      await exited
      const status = invoke(root, state, ['status'])
      expect(status.status, status.stderr).toBe(0)
      expect(JSON.parse(status.stdout).session.status).toBe('running')
      const next = invoke(root, state, ['run', '--', process.execPath, '-e', 'process.stdout.write("UNSAFE_NEW_RUN")'])
      expect(next.status).toBe(2)
      expect(next.stdout).not.toContain('UNSAFE_NEW_RUN')
      console.log(JSON.stringify({ evidence: 'wrapper-process-kill', wrapperPid: wrapper.pid, childPid, persistedStatus: 'running', subsequentRunExit: next.status }))
    } finally {
      wrapper.kill('SIGKILL')
      if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch { /* synthetic child already exited */ } }
    }
  }, 20_000)

  it.each(['after-replace', 'after-journal-completed'] as const)('a fresh CLI resumes %s persisted recovery and the formal loader accepts its final state', async (point) => {
    const f = await restoreFixture()
    const plan = await prepareRestore(f)
    expect((await executeRestore({ ...f, plan, hooks: { [point]: () => { throw new Error('synthetic interruption') } } })).status).not.toBe('succeeded')
    const outcome = invoke(f.workspaceRoot, f.stateRoot, ['rollback'])
    expect(outcome.status, outcome.stderr).toBe(0)
    expect(loadRestoreJournal(f.stateRoot, f.pre.session.workspaceId, f.pre.session.id)?.status).toBe('completed')
    expect(loadSession(f.stateRoot, f.pre.session.workspaceId, f.pre.session.id).status).toBe('rolled_back')
    expect(sessionAdmission(f.stateRoot, f.pre.session.workspaceId).eligible).toBe(true)
  })

  it.each(['accept', 'decline', 'drift'])('Force confirmation transport %s remains bound to the displayed plan and Current', async (mode) => {
    const f = await restoreFixture()
    writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user conflict')
    const output = spawnSync(process.execPath, [path.join(repo, 'tests/fixtures/p3-force-worker.mjs'), mode], {
      cwd: f.workspaceRoot, env: { ...process.env, AGENTCOMMIT_STATE_DIR: f.stateRoot }, encoding: 'utf8', timeout: 15_000,
    })
    expect(output.status, output.stderr).toBe(mode === 'accept' ? 0 : 2)
    expect(readFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'utf8')).toBe(mode === 'accept'
      ? f.original['a-modified.txt'] : mode === 'decline' ? 'user conflict' : 'edited during Force confirmation')
    if (mode !== 'accept') expect(readFileSync(path.join(f.workspaceRoot, 'outside-scope.txt'), 'utf8')).toBe('outside agent edit')
  })

  it('run passes literal argv, keeps a nonzero child exit reviewable, and commit never touches Git', () => {
    const temp = makeTempDir('agentcommit-p3-cli-run-')
    const root = path.join(temp, 'workspace')
    const state = path.join(temp, 'state')
    mkdirSync(root)
    initializeWorkspace(root)
    writeFileSync(path.join(root, 'original.txt'), 'before')
    mkdirSync(path.join(root, '.git'))
    writeFileSync(path.join(root, '.git', 'index'), 'synthetic git bytes')
    const script = `require('node:fs').writeFileSync('original.txt', 'after'); require('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(1))); process.exitCode=7`
    const args = ['中文 空格', '$(echo danger)', '; touch injected', '--force', '']
    const run = invoke(root, state, ['run', '--allow-unprotected', '--', process.execPath, '-e', script, '--', ...args])
    expect(run.status, run.stderr).toBe(7)
    expect(JSON.parse(readFileSync(path.join(root, 'args.json'), 'utf8'))).toEqual(args)
    const status = invoke(root, state, ['status'])
    expect(status.status, status.stderr).toBe(0)
    expect(status.stdout).toContain('review')
    const diff = invoke(root, state, ['diff', 'original.txt'])
    expect(diff.status, diff.stderr).toBe(0)
    expect(diff.stdout).toContain('-before')
    expect(diff.stdout).toContain('+after')
    const accepted = invoke(root, state, ['commit'])
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.stdout).toContain('This did NOT create a Git commit.')
    expect(readFileSync(path.join(root, '.git', 'index'), 'utf8')).toBe('synthetic git bytes')
    expect(invoke(root, state, ['history']).stdout).toContain('committed')
  })

  it('noninteractive unprotected paths refuse before spawn unless explicitly allowed', () => {
    const temp = makeTempDir('agentcommit-p3-cli-gate-')
    const root = path.join(temp, 'workspace')
    const state = path.join(temp, 'state')
    mkdirSync(root)
    initializeWorkspace(root)
    writeFileSync(path.join(root, '.agentcommitignore'), 'unprotected.txt\n')
    writeFileSync(path.join(root, 'unprotected.txt'), 'outside protection')
    const run = invoke(root, state, ['run', '--', process.execPath, '-e', 'process.stdout.write("CHILD_STARTED")'])
    expect(run.status).toBe(2)
    expect(run.stdout).not.toContain('CHILD_STARTED')
    expect(run.stdout + run.stderr).toContain('unprotected.txt')
  })

  it('init creates an explicit workspace and refuses to overwrite it', () => {
    const root = makeTempDir('agentcommit-p3-init-')
    const state = path.join(root, 'isolated-state')
    expect(invoke(root, state, ['init']).status).toBe(0)
    const before = readFileSync(path.join(root, '.agentcommit.json'))
    expect(invoke(root, state, ['init']).status).toBe(2)
    expect(readFileSync(path.join(root, '.agentcommit.json'))).toEqual(before)
  })

  it('scoped CLI success stays review and a fresh whole command loads the Journal and completes', async () => {
    const f = await restoreFixture()
    const single = invoke(f.workspaceRoot, f.stateRoot, ['restore', 'a-modified.txt'])
    expect(single.status, single.stderr).toBe(0)
    expect(single.stdout).toContain('Selected scope restored')
    expect(single.stdout).not.toContain('Whole session restored')
    expect(loadSession(f.stateRoot, f.pre.session.workspaceId, f.pre.session.id).status).toBe('review')
    expect(loadRestoreJournal(f.stateRoot, f.pre.session.workspaceId, f.pre.session.id)?.status).toBe('completed')
    const whole = invoke(f.workspaceRoot, f.stateRoot, ['rollback'])
    expect(whole.status, whole.stderr).toBe(0)
    expect(whole.stdout).toContain('Whole session restored')
    expect(sessionAdmission(f.stateRoot, f.pre.session.workspaceId).eligible).toBe(true)
  })

  it('conflicts and noninteractive Force refuse with zero target writes', async () => {
    const f = await restoreFixture()
    writeFileSync(path.join(f.workspaceRoot, 'a-modified.txt'), 'user later edit')
    const before = captureTree(f.workspaceRoot)
    for (const args of [['rollback'], ['rollback', '--force']]) {
      const outcome = invoke(f.workspaceRoot, f.stateRoot, args)
      expect(outcome.status).toBe(2)
      expect(outcome.stdout + outcome.stderr).toMatch(/rejected|CONFLICT/)
      expect(captureTree(f.workspaceRoot)).toEqual(before)
    }
  })
})
