import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { AgentCommitError, ErrorCodes } from '../errors.js'
import { sameIdentity, type CasStore, type FileIdentity } from './types.js'
import { blobsRoot } from '../storage/paths.js'
import { ensureDir } from '../storage/atomic.js'

const SHA256_HEX = /^[0-9a-f]{64}$/
const CHUNK = 1 << 20 // 1 MiB — streaming keeps memory constant regardless of file size

function assertHash(hash: string): void {
  if (!SHA256_HEX.test(hash)) {
    throw new AgentCommitError(ErrorCodes.BlobCorrupt, `Invalid blob address: "${hash}"`)
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Filesystem CAS under `<stateRoot>/blobs/sha256/<ab>/<cdef…>` (docs/STORAGE.md §2).
 *
 * Integrity rules (P1 rectification):
 * - Writes go to a temp file in the shard dir, fsync, atomic rename.
 * - Dedupe against an existing target REQUIRES integrity verification: the
 *   existing bytes must re-hash to the expected address, otherwise
 *   BLOB_CORRUPT — never a silent "dedupe success" over a corrupt baseline.
 * - Reads re-hash: BLOB_MISSING / BLOB_CORRUPT, never unverified bytes.
 * - putFromFile/putFileStable validate file identity before and after the
 *   streaming read (TOCTOU guard): a file that mutates mid-snapshot is never
 *   stored; stable errors surface as FILE_CHANGED_DURING_SNAPSHOT.
 */
export class FSCasStore implements CasStore {
  private readonly root: string

  /**
   * Optional test-isolation seam (P1 acceptance patch): invoked with the source
   * path after the bytes have been read but BEFORE the final identity (fstat B)
   * check. Undefined in production; tests subclass FSCasStore and mutate the
   * file at this exact, deterministic point so the REAL fstat-B detection is
   * exercised end-to-end (no mocks of the detection logic, no sleeps).
   */
  protected beforeStableReadVerify?: (filePath: string) => void

  constructor(stateRoot: string) {
    this.root = blobsRoot(stateRoot)
  }

  private blobPath(hash: string): string {
    assertHash(hash)
    return path.join(this.root, hash.slice(0, 2), hash.slice(2))
  }

  private identityFromFd(fd: number): FileIdentity {
    const st = fstatSync(fd, { bigint: true })
    return { size: st.size, mtimeNs: st.mtimeNs, ino: st.ino, dev: st.dev }
  }

  private assertIdentity(actual: FileIdentity, expected: FileIdentity): void {
    if (!sameIdentity(actual, expected)) {
      throw new AgentCommitError(
        ErrorCodes.FileChangedDuringSnapshot,
        'File changed while being read for snapshot (size/mtime/identity mismatch); this read result is discarded and retried — no stable baseline is claimed.',
      )
    }
  }

  async put(content: Uint8Array): Promise<string> {
    const hash = sha256Hex(content)
    await this.writeBlob(hash, { bytes: content })
    return hash
  }

  async putFromFile(filePath: string): Promise<string> {
    // Capture identity from the open handle itself, then re-verify after the
    // read — a self-consistent stable read for callers without a prior stat.
    const fd = openSync(filePath, 'r')
    let expected: FileIdentity
    try {
      expected = this.identityFromFd(fd)
    } finally {
      closeSync(fd)
    }
    return this.putFileStable(filePath, expected)
  }

  async putFileStable(filePath: string, expected: FileIdentity): Promise<string> {
    const fd = openSync(filePath, 'r')
    const tmp = path.join(this.root, `.incoming-${process.pid}-${randomUUID()}`)
    ensureDir(this.root)
    const hash = createHash('sha256')
    try {
      this.assertIdentity(this.identityFromFd(fd), expected)
      const out = openSync(tmp, 'w')
      try {
        const buffer = Buffer.allocUnsafe(CHUNK)
        for (;;) {
          const read = readSync(fd, buffer, 0, CHUNK, null)
          if (read === 0) break
          hash.update(buffer.subarray(0, read))
          let offset = 0
          while (offset < read) {
            offset += writeSync(out, buffer, offset, read - offset)
          }
        }
        // Test-isolation seam: deterministic mutation point after the read,
        // before the final fstat B check (production never sets the hook).
        this.beforeStableReadVerify?.(filePath)
        this.assertIdentity(this.identityFromFd(fd), expected)
        fsyncSync(out)
      } finally {
        closeSync(out)
      }
    } catch (error) {
      rmSync(tmp, { force: true }) // temp cleanup on any failure
      throw error
    } finally {
      closeSync(fd)
    }
    const digest = hash.digest('hex')
    await this.writeBlob(digest, { stagedTmp: tmp })
    return digest
  }

  async get(hash: string): Promise<Uint8Array> {
    const p = this.blobPath(hash)
    if (!existsSync(p)) {
      throw new AgentCommitError(ErrorCodes.BlobMissing, `Blob not found in CAS: ${hash}`)
    }
    const data = readFileSync(p)
    if (sha256Hex(data) !== hash) {
      throw new AgentCommitError(
        ErrorCodes.BlobCorrupt,
        `Blob content does not match its address (corrupt): ${hash}`,
      )
    }
    return data
  }

  async has(hash: string): Promise<boolean> {
    return existsSync(this.blobPath(hash))
  }

  async verify(hash: string): Promise<boolean> {
    try {
      await this.get(hash)
      return true
    } catch {
      return false
    }
  }

  /**
   * Dedupe-aware atomic store. Either in-memory `bytes` or an already-staged
   * temp file (`stagedTmp`, from putFileStable). If the target exists it is
   * integrity-verified first: valid ⇒ dedupe; corrupt ⇒ BLOB_CORRUPT and the
   * pre-snapshot fails closed (Blocker 4). Temps are always cleaned up.
   */
  private async writeBlob(
    hash: string,
    source: { bytes?: Uint8Array; stagedTmp?: string },
  ): Promise<void> {
    const target = this.blobPath(hash)
    if (existsSync(target)) {
      if (source.stagedTmp !== undefined) rmSync(source.stagedTmp, { force: true })
      // Existing target must still match its address — never dedupe onto a
      // corrupt baseline.
      const existing = readFileSync(target)
      if (sha256Hex(existing) !== hash) {
        throw new AgentCommitError(
          ErrorCodes.BlobCorrupt,
          `Existing CAS blob is corrupt; refusing to dedupe over it: ${hash}`,
        )
      }
      return
    }
    ensureDir(path.dirname(target))
    let tmp: string
    if (source.stagedTmp !== undefined) {
      tmp = source.stagedTmp
    } else {
      const bytes = source.bytes
      if (bytes === undefined) {
        throw new AgentCommitError(ErrorCodes.StateCorrupt, 'writeBlob requires bytes or stagedTmp')
      }
      tmp = path.join(
        path.dirname(target),
        `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`,
      )
      const fd = openSync(tmp, 'w')
      try {
        let offset = 0
        while (offset < bytes.length) {
          offset += writeSync(fd, bytes, offset, bytes.length - offset)
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    try {
      renameSync(tmp, target)
    } catch (error) {
      rmSync(tmp, { force: true })
      if (!existsSync(target)) throw error
      // else: a concurrent writer stored the same content — dedupe, fine.
    }
  }
}
