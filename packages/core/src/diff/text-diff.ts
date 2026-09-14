import { createTwoFilesPatch } from 'diff'
import type { CasStore } from '../cas/types.js'
import type { Change } from './types.js'

export type DiffMode = 'text' | 'binary' | 'metadata-only' | 'unavailable'

export interface DiffResult {
  mode: DiffMode
  /** Unified diff (text mode only) — never written anywhere by core. */
  patch?: string
  /** Binary/metadata summary: types, hashes (truncatable by callers), sizes. */
  meta?: {
    pre?: { type: string; hash?: string; size: number }
    post?: { type: string; hash?: string; size: number }
  }
  note?: string
}

/** Heuristic: any NUL byte or invalid UTF-8 (U+FFFD) ⇒ treat as binary. */
function looksTextual(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return !decoded.includes('\uFFFD')
}

/**
 * Read-only diff for one change (P2-A). Text files get a real unified diff via
 * jsdiff (IQ-01); binaries and metadata-only changes get metadata only; nothing
 * is ever written to disk and encodings/newlines are untouched. `scope`
 * filters by path prefix (path itself or anything under `scope/`).
 */
export async function describeChange(
  cas: CasStore,
  change: Change,
  options: { scope?: string } = {},
): Promise<DiffResult> {
  if (options.scope !== undefined) {
    const s = options.scope.replace(/\/+$/, '')
    if (change.path !== s && !change.path.startsWith(`${s}/`)) {
      return { mode: 'unavailable', note: 'outside requested scope' }
    }
  }
  if (change.kind === 'metadata-only') {
    return {
      mode: 'metadata-only',
      meta: {
        pre: change.pre && { type: change.pre.type, hash: change.pre.hash, size: change.pre.size },
        post: change.post && { type: change.post.type, hash: change.post.hash, size: change.post.size },
      },
      note: change.note,
    }
  }
  if (change.kind === 'deleted' && change.pre?.hash) {
    const bytes = await cas.get(change.pre.hash)
    if (looksTextual(bytes)) {
      return {
        mode: 'text',
        patch: createTwoFilesPatch('a/' + change.path, 'b/' + change.path, Buffer.from(bytes).toString('utf8'), '', 'pre', 'post'),
      }
    }
    return { mode: 'binary', meta: { pre: { type: change.pre.type, hash: change.pre.hash, size: change.pre.size } } }
  }
  const preBytes = change.pre?.hash ? await cas.get(change.pre.hash) : undefined
  const postBytes = change.post?.hash ? await cas.get(change.post.hash) : undefined

  if (preBytes === undefined || postBytes === undefined) {
    // e.g. created with post hash, capability-gap sides: metadata only.
    return {
      mode: change.post?.hash ? 'binary' : 'unavailable',
      meta: {
        pre: change.pre && { type: change.pre.type, hash: change.pre.hash, size: change.pre.size },
        post: change.post && { type: change.post.type, hash: change.post.hash, size: change.post.size },
      },
      note: change.note,
    }
  }
  if (!looksTextual(preBytes) || !looksTextual(postBytes)) {
    return {
      mode: 'binary',
      meta: {
        pre: { type: change.pre?.type ?? 'file', hash: change.pre?.hash, size: change.pre?.size ?? 0 },
        post: { type: change.post?.type ?? 'file', hash: change.post?.hash, size: change.post?.size ?? 0 },
      },
    }
  }
  return {
    mode: 'text',
    patch: createTwoFilesPatch(
      'a/' + change.path,
      'b/' + change.path,
      Buffer.from(preBytes).toString('utf8'),
      Buffer.from(postBytes).toString('utf8'),
      'pre',
      'post',
    ),
  }
}
