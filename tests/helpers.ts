import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Hermetic temp directory for one test. */
export function makeTempDir(prefix = 'agentcommit-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Write a set of workspace-relative files, creating parent directories. */
export function writeTree(
  root: string,
  files: Record<string, string | Uint8Array>,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
}

/** Isolated AgentCommit state root inside a test temp dir. */
export function makeStateRoot(tmp: string): string {
  const stateRoot = path.join(tmp, 'state')
  mkdirSync(stateRoot, { recursive: true })
  return stateRoot
}

/** SHA-256 of the empty string. */
export const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** A valid-looking (but essentially random) blob address. */
export const FAKE_HASH = 'f'.repeat(64)
