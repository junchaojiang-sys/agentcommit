import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AgentCommitError,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  ErrorCodes,
  FSCasStore,
  createPreSnapshot,
  createIgnoreEngine,
  initializeWorkspace,
  atomicWriteJson,
  scanWorkspace,
} from '@agentcommit/core'
import { makeTempDir, writeTree } from '../helpers.js'

async function scanWithCap(root: string, cap: number) {
  return scanWorkspace({
    root,
    ignore: createIgnoreEngine(root),
    maxFileSizeBytes: cap,
    cas: new FSCasStore(mkdtempSync(path.join(os.tmpdir(), 'ac-cap-cas-'))),
  })
}

describe('large file policy (default 100 MB, OQ-06 per-project override)', () => {
  it('default cap constant is 100 MB', () => {
    expect(DEFAULT_MAX_FILE_SIZE_BYTES).toBe(100 * 1024 * 1024)
  })

  it('below cap → protected; exactly at cap → protected; above cap → unprotected with reason', async () => {
    const root = makeTempDir()
    const cap = 10
    writeTree(root, {
      'small.txt': '12345', // 5 bytes  < cap
      'exact.txt': '1234567890', // 10 bytes = cap
      'big.bin': '12345678901', // 11 bytes > cap
    })
    const { files, stats } = await scanWithCap(root, cap)
    const byPath = new Map(files.map((f) => [f.path, f]))

    expect(byPath.get('small.txt')?.protected).toBe(true)
    expect(byPath.get('exact.txt')?.protected).toBe(true)
    const big = byPath.get('big.bin')
    expect(big?.protected).toBe(false)
    expect(big?.reasonUnprotected).toBe('file-too-large')
    expect(big?.size).toBe(11)
    expect(big?.hash).toBeUndefined()
    expect(stats.byReason['file-too-large']).toBe(1)
  })

  it('oversized files are recorded in the manifest, never silently skipped', async () => {
    const root = makeTempDir()
    writeTree(root, { 'huge.bin': 'x'.repeat(64) })
    const { files } = await scanWithCap(root, 8)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('huge.bin')
    expect(files[0]?.reasonUnprotected).toBe('file-too-large')
  })

  it('per-project override via .agentcommit.json is honored (lower cap ⇒ more unprotected)', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, {
      'a.txt': '12345', // 5 bytes
      'b.bin': '12345678901234567890', // 20 bytes
    })
    // lower the cap to 10 bytes
    const configPath = path.join(ws, '.agentcommit.json')
    const config = JSON.parse(await import('node:fs').then((m) => m.readFileSync(configPath, 'utf8')))
    config.maxFileSizeBytes = 10
    atomicWriteJson(configPath, config)

    const stateRoot = makeTempDir()
    const { manifest, summary } = await createPreSnapshot({ workspaceRoot: ws, stateRoot })

    expect(manifest.maxFileSizeBytes).toBe(10)
    const byPath = new Map(manifest.files.map((f) => [f.path, f]))
    expect(byPath.get('a.txt')?.protected).toBe(true)
    expect(byPath.get('b.bin')?.protected).toBe(false)
    expect(byPath.get('b.bin')?.reasonUnprotected).toBe('file-too-large')
    // init-created files are ALSO oversized under the tiny cap — nothing silent
    expect(summary.unprotectedPaths).toEqual([
      { path: '.agentcommit.json', reason: 'file-too-large', size: expect.any(Number) },
      { path: '.agentcommitignore', reason: 'file-too-large', size: expect.any(Number) },
      { path: 'b.bin', reason: 'file-too-large', size: 20 },
    ])
  })

  it('non-integer or non-positive cap in config is STATE_CORRUPT', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    const configPath = path.join(ws, '.agentcommit.json')
    const fs = await import('node:fs')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    config.maxFileSizeBytes = -5
    atomicWriteJson(configPath, config)
    try {
      await createPreSnapshot({ workspaceRoot: ws, stateRoot: makeTempDir() })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.StateCorrupt)
    }
  })
})
