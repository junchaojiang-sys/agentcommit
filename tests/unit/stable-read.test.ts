import { describe, expect, it } from 'vitest'
import {
  appendFileSync,
  existsSync,
  readdirSync,
  utimesSync,
} from 'node:fs'
import path from 'node:path'
import {
  AgentCommitError,
  ErrorCodes,
  FSCasStore,
  SessionStatus,
  blobsRoot,
  createIgnoreEngine,
  createPreSnapshot,
  initializeWorkspace,
  loadSession,
  scanWorkspace,
  type CasStore,
  type FileIdentity,
} from '@agentcommit/core'
import { makeTempDir, makeStateRoot, writeTree } from '../helpers.js'

/**
 * Real FSCasStore with a test-isolation seam: mutates the source file at the
 * deterministic point AFTER the bytes are read but BEFORE the final identity
 * (fstat B) check. The detection logic itself is the production code — nothing
 * about the check is mocked.
 */
class RealMidReadMutator extends FSCasStore {
  protected override beforeStableReadVerify = (filePath: string): void => {
    appendFileSync(filePath, Buffer.from('+mid-read append'))
  }
}

function anyTempIncoming(stateRoot: string): boolean {
  const root = blobsRoot(stateRoot)
  if (!existsSync(root)) return false
  for (const shard of readdirSync(root)) {
    for (const file of readdirSync(path.join(root, shard))) {
      if (file.startsWith('.incoming-')) return true
    }
  }
  return false
}

/** Stub CAS whose putFileStable fails N times with FILE_CHANGED, then delegates. */
class FlakyStableCas implements CasStore {
  private readonly inner = new FSCasStore(makeStateRoot(makeTempDir()))
  calls = 0
  constructor(private readonly failTimes: number) {}
  put(content: Uint8Array) {
    return this.inner.put(content)
  }
  putFromFile(filePath: string) {
    return this.inner.putFromFile(filePath)
  }
  async putFileStable(filePath: string, expected: FileIdentity): Promise<string> {
    this.calls++
    if (this.calls <= this.failTimes) {
      throw new AgentCommitError(
        ErrorCodes.FileChangedDuringSnapshot,
        'simulated concurrent mutation',
      )
    }
    return this.inner.putFileStable(filePath, expected)
  }
  get(hash: string) {
    return this.inner.get(hash)
  }
  has(hash: string) {
    return this.inner.has(hash)
  }
  verify(hash: string) {
    return this.inner.verify(hash)
  }
}

class AlwaysUnstableCas extends FlakyStableCas {
  constructor() {
    super(Number.MAX_SAFE_INTEGER)
  }
}

describe('stable file read / TOCTOU guard (Blocker 2)', () => {
  it('a stable file snapshots normally via putFileStable', async () => {
    const root = makeTempDir()
    writeTree(root, { 'a.txt': 'stable content' })
    const cas = new FSCasStore(makeStateRoot(makeTempDir()))
    const { files } = await scanWorkspace({
      root,
      ignore: createIgnoreEngine(root),
      maxFileSizeBytes: 1024,
      cas,
    })
    expect(files.find((f) => f.path === 'a.txt')?.protected).toBe(true)
  })

  it('identity mismatch (mutated before read) fails closed — no temp left behind', async () => {
    const tmp = makeTempDir()
    const file = path.join(tmp, 'data.bin')
    writeTree(tmp, { 'data.bin': 'original' })
    const stateRoot = makeStateRoot(makeTempDir())
    const cas = new FSCasStore(stateRoot)

    const st = (await import('node:fs')).lstatSync(file, { bigint: true })
    const staleIdentity: FileIdentity = {
      size: st.size,
      mtimeNs: st.mtimeNs,
      ino: st.ino,
      dev: st.dev,
    }
    // mutate mtime AFTER identity was captured — exactly the TOCTOU signature
    const later = new Date(Date.now() + 3_600_000)
    utimesSync(file, later, later)

    try {
      await cas.putFileStable(file, staleIdentity)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.FileChangedDuringSnapshot)
    }
    expect(anyTempIncoming(stateRoot)).toBe(false)
  })

  it('scanner retries a transient change and succeeds', async () => {
    const root = makeTempDir()
    writeTree(root, { 'flaky.txt': 'content' })
    const cas = new FlakyStableCas(1)
    const { files } = await scanWorkspace({
      root,
      ignore: createIgnoreEngine(root),
      maxFileSizeBytes: 1024,
      cas,
    })
    expect(cas.calls).toBe(2)
    expect(files.find((f) => f.path === 'flaky.txt')?.protected).toBe(true)
  })

  it('a persistently changing file fails closed after retries', async () => {
    const root = makeTempDir()
    writeTree(root, { 'moving.txt': 'content' })
    const cas = new AlwaysUnstableCas()
    try {
      await scanWorkspace({
        root,
        ignore: createIgnoreEngine(root),
        maxFileSizeBytes: 1024,
        cas,
      })
      expect.unreachable('scan should have failed closed')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.FileChangedDuringSnapshot)
    }
    expect(cas.calls).toBe(3) // initial + 2 retries, then fail closed
  })

  it('an unstable pre-snapshot produces NO successful baseline', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'moving.txt': 'content' })
    const stateRoot = makeStateRoot(makeTempDir())

    try {
      await createPreSnapshot({ workspaceRoot: ws, stateRoot, cas: new AlwaysUnstableCas() })
      expect.unreachable('pre-snapshot should have failed closed')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.FileChangedDuringSnapshot)
    }
    // session recorded as failed; no manifest persisted
    const sessionsDir = path.join(stateRoot, 'workspaces')
    const wsDir = readdirSync(sessionsDir)[0]
    const sessionFile = readdirSync(path.join(sessionsDir, wsDir, 'sessions'))[0]
    const session = loadSession(stateRoot, wsDir, sessionFile.replace(/\.json$/, ''))
    expect(session.status).toBe(SessionStatus.Failed)
    expect(existsSync(path.join(sessionsDir, wsDir, 'manifests'))).toBe(false)
  })

  it('REAL mid-read mutation: the final fstat B check rejects the read (no mocks)', async () => {
    const tmp = makeTempDir()
    writeTree(tmp, { 'db.bin': 'x'.repeat(8192) })
    const file = path.join(tmp, 'db.bin')
    const stateRoot = makeStateRoot(makeTempDir())
    const cas = new RealMidReadMutator(stateRoot)

    try {
      await cas.putFromFile(file) // real implementation, seam mutates mid-read
      expect.unreachable('putFromFile should have failed closed')
    } catch (error) {
      // The error is produced by the production fstat-B comparison — the seam
      // only performs the mutation; it never throws anything itself.
      expect((error as AgentCommitError).code).toBe(ErrorCodes.FileChangedDuringSnapshot)
    }
    expect(anyTempIncoming(stateRoot)).toBe(false)
  })

  it('REAL mid-read mutation propagates fail-closed through scanWorkspace', async () => {
    const root = makeTempDir()
    writeTree(root, { 'moving.db': 'y'.repeat(4096) })
    const cas = new RealMidReadMutator(makeStateRoot(makeTempDir()))

    try {
      await scanWorkspace({
        root,
        ignore: createIgnoreEngine(root),
        maxFileSizeBytes: 1024 * 1024,
        cas,
      })
      expect.unreachable('scan should have failed closed')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.FileChangedDuringSnapshot)
    }
  })

  it('REAL mid-read mutation through createPreSnapshot: session failed, no manifest', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'moving.db': 'y'.repeat(4096) })
    const stateRoot = makeStateRoot(makeTempDir())

    try {
      await createPreSnapshot({
        workspaceRoot: ws,
        stateRoot,
        cas: new RealMidReadMutator(stateRoot),
      })
      expect.unreachable('pre-snapshot should have failed closed')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.FileChangedDuringSnapshot)
    }
    const sessionsDir = path.join(stateRoot, 'workspaces')
    const wsDir = readdirSync(sessionsDir)[0]
    const sessionFile = readdirSync(path.join(sessionsDir, wsDir, 'sessions'))[0]
    const session = loadSession(stateRoot, wsDir, sessionFile.replace(/\.json$/, ''))
    expect(session.status).toBe(SessionStatus.Failed)
    expect(existsSync(path.join(sessionsDir, wsDir, 'manifests'))).toBe(false)
  })
})
