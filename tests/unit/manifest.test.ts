import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  AgentCommitError,
  ErrorCodes,
  FSCasStore,
  buildManifest,
  buildProtectionSummary,
  captureProtectionPolicy,
  createIgnoreEngine,
  loadManifest,
  scanWorkspace,
  MANIFEST_SCHEMA_VERSION,
  persistManifest,
} from '@agentcommit/core'
import { SHA256_EMPTY, makeTempDir, makeStateRoot, writeTree } from '../helpers.js'

async function scanTwice(root: string) {
  const options = {
    root,
    ignore: createIgnoreEngine(root),
    maxFileSizeBytes: 1024,
    cas: new FSCasStore(makeStateRoot(makeTempDir())),
  }
  const first = await scanWorkspace(options)
  const second = await scanWorkspace(options)
  return { first, second }
}

describe('manifest (frozen: versioned, deterministic, reasonUnprotected, atomic persistence)', () => {
  it('schema version is 2 and fields (incl. frozen policy) are populated', async () => {
    const root = makeTempDir()
    writeTree(root, { 'a.txt': 'a' })
    const scan = await scanWorkspace({
      root,
      ignore: createIgnoreEngine(root),
      maxFileSizeBytes: 1024,
      cas: new FSCasStore(makeStateRoot(makeTempDir())),
    })
    const policy = captureProtectionPolicy(root, 1024)
    const manifest = buildManifest({
      workspaceId: 'ws-123',
      sessionId: 'sess-456',
      protectionPolicy: policy,
      maxFileSizeBytes: 1024,
      scan,
      createdAt: '2026-01-01T00:00:00.000Z',
      id: 'fixed-id',
    })
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION)
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.id).toBe('fixed-id')
    expect(manifest.workspaceId).toBe('ws-123')
    expect(manifest.sessionId).toBe('sess-456')
    expect(manifest.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(manifest.maxFileSizeBytes).toBe(1024)
    // Blocker 1: the manifest embeds the frozen policy
    expect(manifest.protectionPolicy.maxFileSizeBytes).toBe(1024)
    expect(manifest.protectionPolicy.schemaVersion).toBe(1)
    expect(manifest.protectionPolicy.builtinRules).toEqual(policy.builtinRules)
    expect(manifest.ignored).toEqual([])
  })

  it('same tree ⇒ identical file set, hashes, stats, and ignored boundaries', async () => {
    const root = makeTempDir()
    writeTree(root, {
      'b.txt': 'bbb',
      'a.txt': 'aaa',
      'dir/nested.txt': 'n',
      'empty.txt': '',
      'node_modules/pkg.js': 'dep',
    })
    const { first, second } = await scanTwice(root)
    expect(second.files).toEqual(first.files)
    expect(second.stats).toEqual(first.stats)
    expect(second.ignored).toEqual(first.ignored)
    expect(first.files.map((f) => f.path)).toEqual([
      'a.txt',
      'b.txt',
      'dir/nested.txt',
      'empty.txt',
    ])
    const empty = first.files.find((f) => f.path === 'empty.txt')
    expect(empty?.hash).toBe(SHA256_EMPTY)
  })

  it('unprotected reasons are part of the manifest records and stats', async () => {
    const root = makeTempDir()
    writeTree(root, { 'big.bin': 'x'.repeat(100), 'ok.txt': 'ok' })
    const scan = await scanWorkspace({
      root,
      ignore: createIgnoreEngine(root),
      maxFileSizeBytes: 10,
      cas: new FSCasStore(makeStateRoot(makeTempDir())),
    })
    const big = scan.files.find((f) => f.path === 'big.bin')
    expect(big?.protected).toBe(false)
    expect(big?.reasonUnprotected).toBe('file-too-large')
    expect(scan.stats.byReason['file-too-large']).toBe(1)
    expect(scan.stats.protectedFiles).toBe(1)

    const manifest = buildManifest({
      workspaceId: 'w',
      sessionId: 's',
      protectionPolicy: captureProtectionPolicy(root, 10),
      maxFileSizeBytes: 10,
      scan,
    })
    const summary = buildProtectionSummary(manifest)
    expect(summary.unprotectedPaths).toEqual([
      { path: 'big.bin', reason: 'file-too-large', size: 100 },
    ])
  })

  it('ignored boundaries are disclosed with source and rule (Blocker 3)', async () => {
    const root = makeTempDir()
    writeTree(root, {
      '.agentcommitignore': 'private/**\n',
      'node_modules/dep.js': 'dep',
      'private/key.bin': 'secret-ish',
      'app.ts': 'app',
    })
    const scan = await scanWorkspace({
      root,
      ignore: createIgnoreEngine(root),
      maxFileSizeBytes: 1024,
      cas: new FSCasStore(makeStateRoot(makeTempDir())),
    })
    // subtree roots recorded with matched rule — not just a count
    expect(scan.ignored).toEqual([
      {
        path: 'node_modules',
        kind: 'directory',
        source: 'builtin',
        rule: 'node_modules/**',
        reason: 'ignored-by-builtin-rule',
      },
      {
        path: 'private',
        kind: 'directory',
        source: '.agentcommitignore',
        rule: 'private/**',
        reason: 'ignored-by-agentcommitignore',
      },
    ])
    expect(scan.stats.ignoredEntries).toBe(2)
  })

  it('persist + load roundtrip; missing or wrong-version manifest is STATE_CORRUPT', async () => {
    const root = makeTempDir()
    writeTree(root, { 'a.txt': 'a' })
    const scan = await scanWorkspace({
      root,
      ignore: createIgnoreEngine(root),
      maxFileSizeBytes: 1024,
      cas: new FSCasStore(makeStateRoot(makeTempDir())),
    })
    const manifest = buildManifest({
      workspaceId: 'ws',
      sessionId: 'sess',
      protectionPolicy: captureProtectionPolicy(root, 1024),
      maxFileSizeBytes: 1024,
      scan,
    })
    const stateRoot = makeStateRoot(makeTempDir())
    persistManifest(stateRoot, 'ws', manifest)
    expect(loadManifest(stateRoot, 'ws', manifest.id)).toEqual(manifest)

    expect(() => loadManifest(stateRoot, 'ws', 'no-such-id')).toThrow(AgentCommitError)

    // tamper with the schema version
    const p = path.join(stateRoot, 'workspaces', 'ws', 'manifests', `${manifest.id}.json`)
    expect(existsSync(p)).toBe(true)
    const raw = JSON.parse(await import('node:fs').then((m) => m.readFileSync(p, 'utf8')))
    raw.schemaVersion = 99
    const { atomicWriteJson: rewrite } = await import('@agentcommit/core')
    rewrite(p, raw)
    try {
      loadManifest(stateRoot, 'ws', manifest.id)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.StateCorrupt)
    }
  })
})
