import { describe, expect, it } from 'vitest'
import { mkdtempSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FSCasStore, createIgnoreEngine, scanWorkspace } from '@agentcommit/core'
import { SHA256_EMPTY, makeTempDir, writeTree } from '../helpers.js'

async function scan(root: string, maxFileSizeBytes = 100 * 1024 * 1024) {
  return scanWorkspace({
    root,
    ignore: createIgnoreEngine(root),
    maxFileSizeBytes,
    cas: new FSCasStore(mkdtempSync(path.join(os.tmpdir(), 'ac-scan-cas-'))),
  })
}

describe('workspace scanner (frozen: deterministic, never follows links, never escapes)', () => {
  it('records regular, binary, empty, unicode, and space-named files', async () => {
    const root = makeTempDir()
    writeTree(root, {
      'a.txt': 'plain text',
      'bin.dat': Uint8Array.from([0, 1, 2, 254, 255]),
      'empty.txt': '',
      'with space.txt': 'spacey',
      '中文 目录/文件 名.txt': 'unicode',
      'deep/a/b/c/d/e/leaf.txt': 'deep',
    })
    const { files, stats } = await scan(root)

    const byPath = new Map(files.map((f) => [f.path, f]))
    const a = byPath.get('a.txt')
    expect(a?.type).toBe('file')
    expect(a?.protected).toBe(true)
    expect(typeof a?.hash).toBe('string')
    expect(typeof a?.mtimeNs).toBe('string')

    expect(byPath.get('bin.dat')?.protected).toBe(true)
    expect(byPath.get('empty.txt')?.hash).toBe(SHA256_EMPTY)
    expect(byPath.get('with space.txt')?.protected).toBe(true)
    expect(byPath.get('中文 目录/文件 名.txt')?.protected).toBe(true)
    expect(byPath.get('deep/a/b/c/d/e/leaf.txt')?.protected).toBe(true)

    expect(stats.protectedFiles).toBe(6)
    expect(stats.unprotected).toBe(0)
    expect(stats.ignoredEntries).toBe(0)
  })

  it('output is sorted by path (deterministic, code-unit order)', async () => {
    const root = makeTempDir()
    writeTree(root, { 'z.txt': 'z', 'a/1.txt': '1', 'm.txt': 'm' })
    const { files } = await scan(root)
    expect(files.map((f) => f.path)).toEqual(['a/1.txt', 'm.txt', 'z.txt'])
  })

  it('ignores excluded entries and counts them without scanning contents', async () => {
    const root = makeTempDir()
    writeTree(root, {
      'node_modules/pkg/index.js': 'dep',
      '.agentcommitignore': 'cache/**\n',
      'cache/stuff.bin': 'cached',
      'keep.txt': 'keep',
    })
    const { files, stats } = await scan(root)
    const paths = files.map((f) => f.path)
    expect(paths).toContain('keep.txt')
    expect(paths).not.toContain('node_modules/pkg/index.js')
    expect(paths).not.toContain('cache/stuff.bin')
    // .agentcommitignore itself IS protected (not in the default ignore list)
    expect(paths).toContain('.agentcommitignore')
    expect(stats.ignoredEntries).toBeGreaterThanOrEqual(2) // node_modules + cache
  })

  it('symlinks are recorded, never followed, and cannot leak outside the workspace', { skip: process.platform === 'win32' }, async () => {
    const outside = makeTempDir()
    writeTree(outside, { 'outside-secret.txt': 'must not be captured' })

    const root = makeTempDir()
    writeTree(root, { 'inside.txt': 'inside' })
    symlinkSync(path.join(outside, 'outside-secret.txt'), path.join(root, 'escape'))

    const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'ac-link-'))
    const cas = new FSCasStore(stateRoot)
    const { files } = await scanWorkspace({
      root,
      ignore: createIgnoreEngine(root),
      maxFileSizeBytes: 100 * 1024 * 1024,
      cas,
    })

    const link = files.find((f) => f.path === 'escape')
    expect(link).toBeDefined()
    expect(link?.type).toBe('symlink')
    expect(link?.symlinkTarget).toBeTruthy()
    expect(link?.hash).toBeUndefined() // link content not captured
    // outside file never entered the manifest
    expect(files.some((f) => f.path.includes('outside-secret'))).toBe(false)
  })

  it('a symlinked DIRECTORY is recorded but not descended into', { skip: process.platform === 'win32' }, async () => {
    const outside = makeTempDir()
    writeTree(outside, { 'inner.txt': 'leak?' })

    const root = makeTempDir()
    writeTree(root, { 'real.txt': 'real' })
    symlinkSync(outside, path.join(root, 'dir-link'), 'dir')

    const { files } = await scan(root)
    expect(files.some((f) => f.path === 'dir-link/inner.txt')).toBe(false)
    expect(files.find((f) => f.path === 'dir-link')).toBeDefined()
  })

  it('Windows junction to an outside directory never escapes the workspace', { skip: process.platform !== 'win32' }, async () => {
    const outside = makeTempDir()
    writeTree(outside, { 'junction-secret.txt': 'nope' })
    const root = makeTempDir()
    writeTree(root, { 'own.txt': 'own' })
    symlinkSync(outside, path.join(root, 'junc'), 'junction')

    const { files } = await scan(root)
    expect(files.find((f) => f.path === 'junc')?.type).toBe('junction')
    expect(files.some((f) => f.path.startsWith('junc/'))).toBe(false)
    expect(files.some((f) => f.path.includes('junction-secret'))).toBe(false)
  })

  it('unreadable file is recorded as inaccessible, not silently skipped', { skip: process.platform === 'win32' }, async () => {
    const root = makeTempDir()
    writeTree(root, { 'ok.txt': 'ok', 'locked.txt': 'locked' })
    const { chmodSync } = await import('node:fs')
    chmodSync(path.join(root, 'locked.txt'), 0o000)
    try {
      const { files, stats } = await scan(root)
      const locked = files.find((f) => f.path === 'locked.txt')
      expect(locked?.protected).toBe(false)
      expect(locked?.reasonUnprotected).toBe('inaccessible')
      expect(stats.byReason['inaccessible']).toBe(1)
      expect(files.find((f) => f.path === 'ok.txt')?.protected).toBe(true)
    } finally {
      chmodSync(path.join(root, 'locked.txt'), 0o644)
    }
  })

  it('respects the .agentcommitignore through the scanner', async () => {
    const root = makeTempDir()
    writeTree(root, {
      '.agentcommitignore': '*.log\ntmp/\n',
      'app.log': 'log',
      'tmp/x.bin': 'tmp',
      'src/main.ts': 'code',
    })
    const { files, stats } = await scan(root)
    const paths = files.map((f) => f.path)
    expect(paths).toEqual(['.agentcommitignore', 'src/main.ts'])
    expect(stats.ignoredEntries).toBe(2) // app.log + tmp/
  })

  it('ignored boundaries disclosed: builtin + custom sources with matched rules (Blocker 3)', async () => {
    const root = makeTempDir()
    writeTree(root, {
      '.agentcommitignore': 'private/**\n',
      'node_modules/a.js': 'a',
      'private/key.txt': 'k',
      'keep.txt': 'keep',
    })
    const { files, ignored, stats } = await scan(root)
    expect(ignored).toEqual([
      {
        path: 'node_modules',
        kind: 'directory',
        source: 'builtin',
        rule: 'node_modules/**',
        reason: 'ignored-by-builtin-rule',
      },
      {
        path: 'private',
        kind: 'directory',
        source: '.agentcommitignore',
        rule: 'private/**',
        reason: 'ignored-by-agentcommitignore',
      },
    ])
    expect(stats.ignoredEntries).toBe(2)
    expect(files.some((f) => f.path.startsWith('node_modules'))).toBe(false)
    expect(files.some((f) => f.path.startsWith('private'))).toBe(false)
  })

  it('negation re-includes files under a glob-excluded directory', async () => {
    const root = makeTempDir()
    writeTree(root, {
      '.agentcommitignore': 'build/**\n!build/keep.txt\n',
      'build/keep.txt': 'keep',
      'build/drop.log': 'drop',
    })
    const { files, ignored } = await scan(root)
    const keep = files.find((f) => f.path === 'build/keep.txt')
    expect(keep?.protected).toBe(true) // re-included and protected
    expect(files.some((f) => f.path === 'build/drop.log')).toBe(false)
    expect(ignored).toEqual([
      {
        path: 'build/drop.log',
        kind: 'file',
        source: '.agentcommitignore',
        rule: 'build/**',
        reason: 'ignored-by-agentcommitignore',
      },
    ])
  })

  it('DOCUMENTED SUBSET: a dir-level exclusion prunes negated children (same as git)', async () => {
    const root = makeTempDir()
    writeTree(root, {
      '.agentcommitignore': 'build/\n!build/keep.txt\n',
      'build/keep.txt': 'keep',
    })
    const { files, ignored } = await scan(root)
    // git semantics: children of an excluded directory cannot be re-included.
    // This limitation is documented (P1 report, Ignore Semantics) — never silent.
    expect(files.some((f) => f.path === 'build/keep.txt')).toBe(false)
    expect(ignored).toEqual([
      {
        path: 'build',
        kind: 'directory',
        source: '.agentcommitignore',
        rule: 'build/',
        reason: 'ignored-by-agentcommitignore',
      },
    ])
  })
})
