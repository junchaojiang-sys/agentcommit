import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  AgentCommitError,
  ErrorCodes,
  SessionStatus,
  acquireLock,
  createIgnoreEngineFromPolicy,
  createPreSnapshot,
  initializeWorkspace,
  loadManifest,
  loadSession,
  lockPath,
  policyDigest,
  releaseLock,
  resolveWorkspace,
} from '@agentcommit/core'
import { makeTempDir, makeStateRoot, writeTree } from '../helpers.js'

function countBlobs(stateRoot: string): number {
  const root = path.join(stateRoot, 'blobs', 'sha256')
  let count = 0
  for (const shard of readdirSync(root)) {
    count += readdirSync(path.join(root, shard)).length
  }
  return count
}

describe('pre-snapshot end-to-end (resolve → lock → scan → CAS → manifest → summary)', () => {
  it('runs the full frozen chain in a real workspace', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    // small per-project cap so a "big" file is cheap to create (OQ-06);
    // 32 bytes keeps .env (26 B) protected while big.bin (64 B) is oversized
    const configPath = path.join(ws, '.agentcommit.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.maxFileSizeBytes = 32
    const { atomicWriteJson } = await import('@agentcommit/core')
    atomicWriteJson(configPath, config)

    writeTree(ws, {
      'src/main.ts': 'console.log(1)',
      '.env': 'API_KEY=super-secret-value', // OQ-04: protected by default
      'node_modules/dep/index.js': 'dependency', // default-ignored
      'data/big.bin': 'B'.repeat(64), // > 16 bytes ⇒ unprotected
    })

    const stateRoot = makeStateRoot(makeTempDir())
    const { session, manifest, summary } = await createPreSnapshot({
      workspaceRoot: ws,
      stateRoot,
      agent: { kind: 'generic', command: 'true' },
    })

    // session: snapshot state with pre-manifest ref, persisted atomically
    expect(session.status).toBe(SessionStatus.Snapshot)
    expect(session.preManifestRef).toBe(manifest.id)
    const loadedSession = loadSession(stateRoot, manifest.workspaceId, session.id)
    expect(loadedSession.status).toBe(SessionStatus.Snapshot)

    // manifest: persisted, loadable, sorted, complete (includes init-created files)
    const loadedManifest = loadManifest(stateRoot, manifest.workspaceId, manifest.id)
    expect(loadedManifest.files.map((f) => f.path)).toEqual([
      '.agentcommit.json',
      '.agentcommitignore',
      '.env',
      'data/big.bin',
      'src/main.ts',
    ])

    // secrets are protected by default (OQ-04)
    const env = loadedManifest.files.find((f) => f.path === '.env')
    expect(env?.protected).toBe(true)
    expect(typeof env?.hash).toBe('string')
    expect(await import('@agentcommit/core').then((m) => new m.FSCasStore(stateRoot).has(env?.hash as string))).toBe(true)

    // oversized: recorded with reason, NO blob stored for it
    const big = loadedManifest.files.find((f) => f.path === 'data/big.bin')
    expect(big?.protected).toBe(false)
    expect(big?.reasonUnprotected).toBe('file-too-large')

    // ignored entry counted, not recorded
    expect(loadedManifest.files.some((f) => f.path.startsWith('node_modules'))).toBe(false)
    expect(loadedManifest.stats.ignoredEntries).toBe(1)

    // under the 32-byte cap: .agentcommit.json (~115 B) and .agentcommitignore
    // (~361 B) are oversized too — recorded with reasons, nothing silent
    const initConfig = loadedManifest.files.find((f) => f.path === '.agentcommit.json')
    expect(initConfig?.protected).toBe(false)
    expect(initConfig?.reasonUnprotected).toBe('file-too-large')

    // blob count equals content-protected files (2: .env, src/main.ts)
    expect(countBlobs(stateRoot)).toBe(2)

    // protection summary data (TRANSACTION_MODEL §4)
    expect(summary.protectedFiles).toBe(2)
    expect(summary.unprotectedPaths.map((p) => p.path)).toEqual([
      '.agentcommit.json',
      '.agentcommitignore',
      'data/big.bin',
    ])
    expect(summary.unprotectedPaths.every((p) => p.reason === 'file-too-large')).toBe(true)

    // lock released after the P1 pre-snapshot helper finishes
    expect(existsSync(lockPath(stateRoot, manifest.workspaceId))).toBe(false)
  })

  it('same content across sessions dedupes to one blob', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'only.txt': 'stable content' })
    const stateRoot = makeStateRoot(makeTempDir())

    const first = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    const second = await createPreSnapshot({ workspaceRoot: ws, stateRoot })

    expect(first.session.id).not.toBe(second.session.id)
    expect(first.manifest.id).not.toBe(second.manifest.id)
    const a = first.manifest.files.find((f) => f.path === 'only.txt')
    const b = second.manifest.files.find((f) => f.path === 'only.txt')
    expect(a?.hash).toBe(b?.hash)
    // 3 distinct contents total: only.txt + .agentcommit.json + .agentcommitignore
    expect(countBlobs(stateRoot)).toBe(3)
  })

  it('discovers the workspace from a nested cwd (frozen parent-walk)', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'deep/nested/leaf.txt': 'leaf' })
    const { manifest } = await createPreSnapshot({
      cwd: path.join(ws, 'deep', 'nested'),
      stateRoot: makeStateRoot(makeTempDir()),
    })
    expect(manifest.files.some((f) => f.path === 'deep/nested/leaf.txt')).toBe(true)
  })

  it('fails closed with WORKSPACE_NOT_INITIALIZED outside a workspace (no auto-init)', async () => {
    const tmp = makeTempDir()
    try {
      await createPreSnapshot({ workspaceRoot: tmp, stateRoot: makeStateRoot(makeTempDir()) })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceNotInitialized)
    }
    expect(existsSync(path.join(tmp, '.agentcommit.json'))).toBe(false)
  })

  it('fails closed with WORKSPACE_LOCKED when a valid lock is held', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    const stateRoot = makeStateRoot(makeTempDir())
    const wsId = resolveWorkspace(ws).config.workspaceId
    acquireLock(stateRoot, { workspaceId: wsId, sessionId: 'holder-session' })

    try {
      await createPreSnapshot({ workspaceRoot: ws, stateRoot })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceLocked)
    }
    // the holder's lock is untouched
    expect(existsSync(lockPath(stateRoot, wsId))).toBe(true)
    releaseLock(stateRoot, wsId, 'holder-session')
  })

  it('an unreadable workspace root fails closed with no review baseline', { skip: process.platform === 'win32' }, async () => {
    // POSIX first-run (2026-09-09): chmod 000 makes the workspace config itself
    // unreadable, so no workspace identity exists to attribute a failed-session
    // record to. The real contract is fail-closed: pre-snapshot throws, and nothing
    // is recorded as a review baseline. (A failed-session record for an unreadable
    // ROOT would require out-of-band workspace identity — open product question.)
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'x.txt': 'x' })
    const stateRoot = makeStateRoot(makeTempDir())
    const { chmodSync } = await import('node:fs')
    chmodSync(ws, 0o000)
    let threw = false
    try {
      try {
        await createPreSnapshot({ workspaceRoot: ws, stateRoot })
      } catch {
        threw = true
      }
    } finally {
      chmodSync(ws, 0o755)
    }
    expect(threw).toBe(true)
    const workspacesDir = path.join(stateRoot, 'workspaces')
    // No workspace directory is ever created: pre-snapshot failed closed before
    // any state existed (no baseline, no session, nothing partial).
    expect(existsSync(workspacesDir)).toBe(false)
  })

  it('symlink/junction boundary holds through the full chain', async () => {
    const outside = makeTempDir()
    writeTree(outside, { 'secret-outside.txt': 'never' })
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'inside.txt': 'in' })
    symlinkSync(outside, path.join(ws, 'link-out'), 'junction')

    const stateRoot = makeStateRoot(makeTempDir())
    const { manifest } = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    expect(manifest.files.some((f) => f.path.startsWith('link-out/'))).toBe(false)
    expect(manifest.files.some((f) => f.path.includes('secret-outside'))).toBe(false)
    const link = manifest.files.find((f) => f.path === 'link-out')
    expect(link?.symlinkTarget).toBeTruthy()
  })

  it('frozen policy survives workspace ignore mutation (Blocker 1)', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'a.txt': 'a' })
    const stateRoot = makeStateRoot(makeTempDir())
    const { manifest } = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    const digestBefore = policyDigest(manifest.protectionPolicy)

    // agent/user mutates ignore rules AFTER the snapshot
    writeFileSync(path.join(ws, '.agentcommitignore'), 'src/\n*.txt\n')

    const reloaded = loadManifest(stateRoot, manifest.workspaceId, manifest.id)
    expect(reloaded.protectionPolicy.ignoreRules).toEqual([])
    expect(policyDigest(reloaded.protectionPolicy)).toBe(digestBefore)
    // the frozen engine still applies the ORIGINAL rules, not the live ones
    const engine = createIgnoreEngineFromPolicy(reloaded.protectionPolicy)
    expect(engine.isIgnored('src/x.ts', false)).toBe(false)
    expect(engine.isIgnored('nothing/here', true)).toBe(false)
  })

  it('corrupt existing blob propagates: second pre-snapshot fails closed (Blocker 4)', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'same.txt': 'identical' })
    const stateRoot = makeStateRoot(makeTempDir())

    const first = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    const hash = first.manifest.files.find((f) => f.path === 'same.txt')?.hash
    expect(hash).toBeDefined()
    const blobPath = path.join(stateRoot, 'blobs', 'sha256', String(hash).slice(0, 2), String(hash).slice(2))
    writeFileSync(blobPath, Buffer.from('corrupted bytes'))

    try {
      await createPreSnapshot({ workspaceRoot: ws, stateRoot })
      expect.unreachable('second snapshot must fail over a corrupt baseline')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.BlobCorrupt)
    }
    // no new trusted manifest was created
    const wsDir = path.join(stateRoot, 'workspaces', first.manifest.workspaceId)
    expect(readdirSync(path.join(wsDir, 'manifests')).length).toBe(1)
    // the failed session is recorded for review
    const sessionFiles = readdirSync(path.join(wsDir, 'sessions'))
    const failedId = sessionFiles.find((f) => f !== `${first.session.id}.json`)
    expect(failedId).toBeDefined()
    const failed = loadSession(
      stateRoot,
      first.manifest.workspaceId,
      String(failedId).replace(/\.json$/, ''),
    )
    expect(failed.status).toBe(SessionStatus.Failed)
  })

  it('secrets never leak into logs: no file contents are written to state metadata', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    const secretValue = 'API_KEY=super-secret-value'
    writeTree(ws, { '.env': secretValue })
    const stateRoot = makeStateRoot(makeTempDir())
    const { manifest } = await createPreSnapshot({ workspaceRoot: ws, stateRoot })

    // scan every state file under the workspace record: the secret VALUE must
    // never appear — only its hash.
    const wsDir = path.join(stateRoot, 'workspaces', manifest.workspaceId)
    for (const rel of ['manifests', 'sessions'] as const) {
      const dir = path.join(wsDir, rel)
      for (const file of readdirSync(dir)) {
        const text = readFileSync(path.join(dir, file), 'utf8')
        expect(text).not.toContain(secretValue)
      }
    }
  })
})
