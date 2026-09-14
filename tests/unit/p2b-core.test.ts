import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createPostSnapshot,
  createPreSnapshot,
  executeRestore,
  initializeWorkspace,
  loadRestoreJournal,
  prepareRestore,
} from '@agentcommit/core'
import { makeStateRoot, makeTempDir, writeTree } from '../helpers.js'

describe('P2-B restore executor core', () => {
  it('prepares, journals, and atomically restores a modified file', async () => {
    const base = makeTempDir()
    const workspaceRoot = path.join(base, 'workspace')
    writeTree(workspaceRoot, { 'a.txt': 'before' })
    const workspace = initializeWorkspace(workspaceRoot)
    const stateRoot = makeStateRoot(base)
    const pre = await createPreSnapshot({ workspaceRoot, stateRoot })
    writeFileSync(path.join(workspaceRoot, 'a.txt'), 'after')
    await createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })

    const plan = await prepareRestore({ workspaceRoot, stateRoot })
    expect(plan.actions.map((action) => action.path)).toEqual(['a.txt'])
    const result = await executeRestore({ workspaceRoot, stateRoot, plan })

    expect(result.status).toBe('succeeded')
    expect(readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8')).toBe('before')
    expect(loadRestoreJournal(stateRoot, workspace.config.workspaceId, pre.session.id)?.status).toBe('completed')
  })

  it('keeps an after-intent failure retryable and completes it on the same API retry', async () => {
    const base = makeTempDir()
    const workspaceRoot = path.join(base, 'workspace')
    writeTree(workspaceRoot, { 'a.txt': 'before' })
    initializeWorkspace(workspaceRoot)
    const stateRoot = makeStateRoot(base)
    const pre = await createPreSnapshot({ workspaceRoot, stateRoot })
    writeFileSync(path.join(workspaceRoot, 'a.txt'), 'after')
    await createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
    const plan = await prepareRestore({ workspaceRoot, stateRoot })

    const first = await executeRestore({
      workspaceRoot,
      stateRoot,
      plan,
      hooks: { 'after-intent': () => { throw new Error('simulated stop') } },
    })
    expect(first.status).toBe('retryable')
    expect(readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8')).toBe('after')

    const retried = await executeRestore({ workspaceRoot, stateRoot, plan })
    expect(retried.status).toBe('succeeded')
    expect(readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf8')).toBe('before')
  })
})
