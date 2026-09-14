import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  AgentCommitError,
  ErrorCodes,
  initializeWorkspace,
  loadConfig,
  resolveWorkspace,
} from '@agentcommit/core'
import { makeTempDir, writeTree } from '../helpers.js'

describe('workspace discovery (frozen: cwd parent-walk, nearest wins, fail closed)', () => {
  it('initializes a workspace and resolves it from the root', () => {
    const ws = makeTempDir()
    const created = initializeWorkspace(ws)

    expect(created.config.workspaceId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(created.config.version).toBe(1)
    expect(created.config.maxFileSizeBytes).toBe(100 * 1024 * 1024)

    const resolved = resolveWorkspace(ws)
    expect(resolved.root).toBe(path.resolve(ws))
    expect(resolved.config.workspaceId).toBe(created.config.workspaceId)
  })

  it('init writes .agentcommit.json and an .agentcommitignore template', () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    const config = loadConfig(path.join(ws, '.agentcommit.json'))
    expect(config.agents).toEqual({})
    // template exists and is inert (all lines commented)
    const ignoreFile = path.join(ws, '.agentcommitignore')
    const text = readFileSync(ignoreFile, 'utf8')
    const activeLines = text.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    expect(activeLines).toEqual([])
  })

  it('refuses to double-initialize (WORKSPACE_ALREADY_INITIALIZED)', () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    try {
      initializeWorkspace(ws)
      expect.unreachable('init should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCommitError)
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceAlreadyInitialized)
    }
  })

  it('resolves from a nested cwd to the nearest workspace root', () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'a/b/c/deep.txt': 'x' })

    const resolved = resolveWorkspace(path.join(ws, 'a', 'b', 'c'))
    expect(resolved.root).toBe(path.resolve(ws))
  })

  it('nearest workspace wins when workspaces are nested', () => {
    const outer = makeTempDir()
    initializeWorkspace(outer)
    const inner = path.join(outer, 'packages', 'app')
    initializeWorkspace(inner)

    const resolved = resolveWorkspace(path.join(inner, 'src'))
    expect(resolved.root).toBe(path.resolve(inner))
    expect(resolved.config.workspaceId).not.toBe(
      resolveWorkspace(outer).config.workspaceId,
    )
  })

  it('fails closed with WORKSPACE_NOT_INITIALIZED when nothing found (no auto-init)', () => {
    const tmp = makeTempDir()
    writeTree(tmp, { 'deep/er/still.txt': 'x' })
    const deep = path.join(tmp, 'deep', 'er')
    try {
      resolveWorkspace(deep)
      expect.unreachable('resolve should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCommitError)
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceNotInitialized)
    }
    // no auto-init happened
    expect(existsSync(path.join(tmp, '.agentcommit.json'))).toBe(false)
  })

  it('corrupt workspace config is STATE_CORRUPT, not silently accepted', () => {
    const ws = makeTempDir()
    writeTree(ws, { '.agentcommit.json': '{ "version": 99, "workspaceId": "x" }' })
    try {
      resolveWorkspace(ws)
      expect.unreachable('resolve should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.StateCorrupt)
    }
  })
})
