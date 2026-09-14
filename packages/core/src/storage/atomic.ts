import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  fsyncSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

/** Create a directory (and parents) if it does not exist. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/**
 * Atomic byte write: temp file in the SAME directory (same volume ⇒ atomic
 * rename), fsync, then rename over the target. A crash can never leave a
 * half-written target (docs/STORAGE.md §3). Windows: fs.rename uses
 * MoveFileEx with REPLACE_EXISTING; a locked target fails loudly instead of
 * corrupting anything.
 */
export function atomicWriteBytes(filePath: string, data: Uint8Array): void {
  const dir = path.dirname(filePath)
  ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`)
  try {
    const fd = openSync(tmp, 'w')
    try {
      let offset = 0
      while (offset < data.length) {
        offset += writeSync(fd, data, offset, data.length - offset)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort temp cleanup; the original error is what matters
    }
    throw error
  }
}

/**
 * Atomic JSON write. The payload is serialized and parse-validated BEFORE the
 * temp file is written, so a serialization bug can never replace a good file
 * with garbage.
 */
export function atomicWriteJson(filePath: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2)
  JSON.parse(json) // validation before anything touches the disk
  atomicWriteBytes(filePath, Buffer.from(json, 'utf8'))
}

/** Read and parse a JSON file. JSON errors surface to the caller. */
export function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}
