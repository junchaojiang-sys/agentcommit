/** On-disk identity used for stable-read (TOCTOU) validation. */
export interface FileIdentity {
  size: bigint
  mtimeNs: bigint
  ino: bigint
  dev: bigint
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino && a.dev === b.dev
  )
}

/**
 * Content-addressable blob store. Content is deduplicated by SHA-256;
 * a blob whose bytes do not re-hash to its address is corrupt and must be
 * reported, never served silently (docs/STORAGE.md §3). Dedupe against an
 * existing target also requires integrity verification — a corrupt existing
 * blob fails closed with BLOB_CORRUPT instead of "dedupe success".
 */
export interface CasStore {
  /** Store content, returns its SHA-256 hex address. Deduplicates (verified). */
  put(content: Uint8Array): Promise<string>
  /**
   * Stream a file into the store (hash and write in one pass, constant
   * memory) and return its SHA-256 hex address. Deduplicates (verified).
   * Throws FILE_CHANGED_DURING_SNAPSHOT if the file mutates mid-read.
   */
  putFromFile(filePath: string): Promise<string>
  /**
   * Like putFromFile, but first validates that the file still matches the
   * identity observed before the read started (TOCTOU guard), and re-validates
   * after the read completes. On mismatch: FILE_CHANGED_DURING_SNAPSHOT.
   */
  putFileStable(filePath: string, expected: FileIdentity): Promise<string>
  /** Read a blob by address. Throws BlobMissing/BlobCorrupt errors on failure. */
  get(hash: string): Promise<Uint8Array>
  has(hash: string): Promise<boolean>
  /** Re-hash the stored bytes and compare to the address. */
  verify(hash: string): Promise<boolean>
}
