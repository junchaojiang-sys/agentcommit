import { lstatSync } from 'node:fs'
import path from 'node:path'

/** Manifest paths are relative and canonical, with forward slashes only. */
export function validateRestorePath(rel: string): string | null {
  if (typeof rel !== 'string' || rel === '' || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return 'absolute or empty path'
  const segments = rel.split(/[\\/]/)
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return 'empty or traversal segment'
  if (segments.some((s) => s.toLowerCase() === '.git')) return '.git is out of restore scope'
  if (['.agentcommit', '.agentcommit.json', '.agentcommitignore'].includes((segments[0] ?? '').toLowerCase())) {
    return 'AgentCommit state/config is out of restore scope'
  }
  if (rel.includes('\\') || /[:\0]/.test(rel) || segments.some((s) => /[. ]$/.test(s))) return 'non-canonical path'
  return null
}

/** Unknown parent state is unsafe; only ENOENT proves a missing parent. */
export function parentLinkEscape(root: string, rel: string): boolean {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i++) {
    try {
      const parent = lstatSync(path.join(root, ...parts.slice(0, i)))
      if (parent.isSymbolicLink() || !parent.isDirectory()) return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }
  return false
}

export function observationPathProblem(root: string, rel: string): string | null {
  const problem = validateRestorePath(rel)
  if (problem) return problem
  const relative = path.relative(path.resolve(root), path.resolve(root, rel))
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return 'path outside workspace'
  if (parentLinkEscape(root, rel)) return 'parent link/junction or inaccessible parent — cannot confirm workspace containment'
  return null
}
