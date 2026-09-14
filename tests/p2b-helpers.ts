import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { createPostSnapshot, createPreSnapshot, initializeWorkspace } from '@agentcommit/core'
import { makeTempDir, makeStateRoot, writeTree } from './helpers.js'

/** All mutation fixtures live under this newly-created synthetic root. */
export async function restoreFixture() {
  const temporaryRoot = makeTempDir('agentcommit-p2b-')
  const workspaceRoot = path.join(temporaryRoot, 'workspace')
  mkdirSync(workspaceRoot)
  initializeWorkspace(workspaceRoot)
  const stateRoot = makeStateRoot(temporaryRoot)
  const original = {
    'a-modified.txt': 'original text\n'.repeat(10_000),
    'b-deleted.txt': 'deleted original',
    'c-empty.txt': '',
    '中文 目录/文件 名.bin': Buffer.from([0, 255, 13, 10, 128]),
    'outside-scope.txt': 'outside original',
  }
  writeTree(workspaceRoot, original)
  const pre = await createPreSnapshot({ workspaceRoot, stateRoot })
  writeTree(workspaceRoot, {
    'a-modified.txt': 'agent text',
    'c-empty.txt': 'was empty',
    '中文 目录/文件 名.bin': Buffer.from([8, 0, 7]),
    'outside-scope.txt': 'outside agent edit',
    'z-created.txt': 'agent created',
  })
  unlinkSync(path.join(workspaceRoot, 'b-deleted.txt'))
  const post = await createPostSnapshot({ workspaceRoot, stateRoot, sessionId: pre.session.id })
  return { temporaryRoot, workspaceRoot, stateRoot, pre, post, original }
}

/** Includes unknown temporary files so accidental workspace residue is visible. */
export function captureTree(root: string) {
  const result: Array<{ path: string; type: string; hash?: string; target?: string; mode: number }> = []
  function walk(dir: string, prefix: string) {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix + name
      const abs = path.join(dir, name)
      const st = lstatSync(abs)
      const mode = st.mode & 0o777
      if (st.isSymbolicLink()) result.push({ path: rel, type: 'link', target: readlinkSync(abs), mode })
      else if (st.isDirectory()) { result.push({ path: rel, type: 'directory', mode }); walk(abs, rel + '/') }
      else if (st.isFile()) result.push({ path: rel, type: 'file', hash: createHash('sha256').update(readFileSync(abs)).digest('hex'), mode })
      else result.push({ path: rel, type: 'other', mode })
    }
  }
  walk(root, '')
  return result
}
