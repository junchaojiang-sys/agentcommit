import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentCommitError, ErrorCodes, FSCasStore, blobsRoot } from '@agentcommit/core'
import { FAKE_HASH, SHA256_EMPTY, makeTempDir } from '../helpers.js'

function countBlobs(stateRoot: string): number {
  const root = blobsRoot(stateRoot)
  let count = 0
  let shards: string[] = []
  try {
    shards = readdirSync(root)
  } catch {
    return 0
  }
  for (const shard of shards) {
    count += readdirSync(path.join(root, shard)).length
  }
  return count
}

describe('SHA-256 CAS (frozen: dedupe, atomic write, integrity, stable errors)', () => {
  it('put/get roundtrip', async () => {
    const cas = new FSCasStore(makeTempDir())
    const hash = await cas.put(Buffer.from('hello world'))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Buffer.from(await cas.get(hash)).toString()).toBe('hello world')
    expect(await cas.has(hash)).toBe(true)
    expect(await cas.verify(hash)).toBe(true)
  })

  it('empty content stores the known empty hash', async () => {
    const cas = new FSCasStore(makeTempDir())
    const hash = await cas.put(Buffer.alloc(0))
    expect(hash).toBe(SHA256_EMPTY)
    expect(Buffer.from(await cas.get(hash)).length).toBe(0)
  })

  it('identical content is stored exactly once (dedupe)', async () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ac-cas-'))
    const cas = new FSCasStore(stateRoot)
    const h1 = await cas.put(Buffer.from('same'))
    const h2 = await cas.put(Buffer.from('same'))
    const h3 = await cas.put(Buffer.from('same'))
    expect(h1).toBe(h2)
    expect(h2).toBe(h3)
    expect(countBlobs(stateRoot)).toBe(1)
  })

  it('different content gets different addresses', async () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ac-cas-'))
    const cas = new FSCasStore(stateRoot)
    await cas.put(Buffer.from('a'))
    await cas.put(Buffer.from('b'))
    expect(countBlobs(stateRoot)).toBe(2)
  })

  it('putFromFile streams a file into the store', async () => {
    const tmp = makeTempDir()
    const file = path.join(tmp, 'big-ish.bin')
    const payload = Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251))
    writeFileSync(file, payload)
    const cas = new FSCasStore(makeTempDir())
    const hash = await cas.putFromFile(file)
    expect(await cas.has(hash)).toBe(true)
    expect(Buffer.from(await cas.get(hash)).equals(payload)).toBe(true)
  })

  it('missing blob → BLOB_MISSING (stable error, never silent)', async () => {
    const cas = new FSCasStore(makeTempDir())
    try {
      await cas.get(FAKE_HASH)
      expect.unreachable('get should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.BlobMissing)
    }
    expect(await cas.has(FAKE_HASH)).toBe(false)
    expect(await cas.verify(FAKE_HASH)).toBe(false)
  })

  it('corrupt blob → BLOB_CORRUPT on read, detected by verify', async () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ac-cas-'))
    const cas = new FSCasStore(stateRoot)
    const hash = await cas.put(Buffer.from('trustworthy content'))

    const blobPath = path.join(blobsRoot(stateRoot), hash.slice(0, 2), hash.slice(2))
    writeFileSync(blobPath, Buffer.from('tampered content!!'))

    try {
      await cas.get(hash)
      expect.unreachable('get should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.BlobCorrupt)
    }
    expect(await cas.verify(hash)).toBe(false)
  })

  it('invalid blob addresses are rejected', async () => {
    const cas = new FSCasStore(makeTempDir())
    await expect(cas.get('not-a-hash')).rejects.toMatchObject({ code: ErrorCodes.BlobCorrupt })
    await expect(cas.get('abc')).rejects.toMatchObject({ code: ErrorCodes.BlobCorrupt })
  })

  it('dedupe over a CORRUPT existing blob fails closed (Blocker 4)', async () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ac-cas-'))
    const cas = new FSCasStore(stateRoot)
    const content = Buffer.from('important baseline')
    const hash = await cas.put(content)
    const blobPath = path.join(blobsRoot(stateRoot), hash.slice(0, 2), hash.slice(2))
    writeFileSync(blobPath, Buffer.from('bit-rotted bytes'))

    // put(): must NOT report dedupe success over corrupt bytes
    try {
      await cas.put(content)
      expect.unreachable('dedupe should have failed')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.BlobCorrupt)
    }

    // putFromFile(): same fail-closed behavior
    const src = path.join(makeTempDir(), 'same.txt')
    writeFileSync(src, content)
    await expect(cas.putFromFile(src)).rejects.toMatchObject({ code: ErrorCodes.BlobCorrupt })
  })

  it('no .incoming temp files remain after successful operations', async () => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ac-cas-'))
    const cas = new FSCasStore(stateRoot)
    const src = path.join(makeTempDir(), 'f.bin')
    writeFileSync(src, Buffer.from('data'))
    await cas.putFromFile(src)
    await cas.put(Buffer.from('data')) // dedupe path
    const root = blobsRoot(stateRoot)
    for (const shard of readdirSync(root)) {
      for (const f of readdirSync(path.join(root, shard))) {
        expect(f.startsWith('.incoming-')).toBe(false)
      }
    }
  })
})
