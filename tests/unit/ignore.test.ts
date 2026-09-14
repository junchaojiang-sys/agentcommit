import { describe, expect, it } from 'vitest'
import { createIgnoreEngine, initializeWorkspace } from '@agentcommit/core'
import { makeTempDir, writeTree } from '../helpers.js'

describe('ignore engine (OQ-03 = A: .gitignore never read; OQ-12: gitignore-style)', () => {
  it('built-in defaults exclude node_modules, .git, dist, build', () => {
    const ws = makeTempDir()
    const engine = createIgnoreEngine(ws)
    expect(engine.isIgnored('node_modules/left-pad/index.js', false)).toBe(true)
    expect(engine.isIgnored('node_modules', true)).toBe(true)
    expect(engine.isIgnored('.git/HEAD', false)).toBe(true)
    expect(engine.isIgnored('dist/bundle.js', false)).toBe(true)
    expect(engine.isIgnored('src/index.ts', false)).toBe(false)
  })

  it('.agentcommitignore excludes files (directory-only rules, **, nesting)', () => {
    const ws = makeTempDir()
    writeTree(ws, {
      '.agentcommitignore': '*.log\ntmp/\ndata/**/*.cache\n/assets\n',
    })
    const engine = createIgnoreEngine(ws)
    expect(engine.isIgnored('debug.log', false)).toBe(true)
    expect(engine.isIgnored('nested/deep/error.log', false)).toBe(true)
    expect(engine.isIgnored('tmp/whatever.bin', false)).toBe(true)
    expect(engine.isIgnored('tmp', true)).toBe(true)
    expect(engine.isIgnored('data/x/y.stamp.cache', false)).toBe(true)
    expect(engine.isIgnored('assets/logo.png', false)).toBe(true) // root-anchored /assets
    expect(engine.isIgnored('src/assets/icon.svg', false)).toBe(false) // anchoring respected
  })

  it('negation re-includes files matched earlier', () => {
    const ws = makeTempDir()
    writeTree(ws, {
      '.agentcommitignore': 'logs/**\n!logs/keep.txt\n',
    })
    const engine = createIgnoreEngine(ws)
    expect(engine.isIgnored('logs/drop.log', false)).toBe(true)
    expect(engine.isIgnored('logs/keep.txt', false)).toBe(false)
  })

  it('handles unicode and spaces in paths', () => {
    const ws = makeTempDir()
    writeTree(ws, {
      '.agentcommitignore': '缓存/**\n临时 file.txt\n',
    })
    const engine = createIgnoreEngine(ws)
    expect(engine.isIgnored('缓存/旧数据.bin', false)).toBe(true)
    expect(engine.isIgnored('临时 file.txt', false)).toBe(true)
    expect(engine.isIgnored('normal.txt', false)).toBe(false)
  })

  it('NEVER reads .gitignore — git-ignored does not mean unprotected (OQ-03)', () => {
    const ws = makeTempDir()
    writeTree(ws, {
      '.gitignore': '.env\nsecret*\n',
    })
    const engine = createIgnoreEngine(ws)
    expect(engine.isIgnored('.env', false)).toBe(false)
    expect(engine.isIgnored('secret.txt', false)).toBe(false)
    expect(engine.isIgnored('.gitignore', false)).toBe(false) // itself is protected too
    expect(engine.sources).not.toContain('.gitignore')
  })

  it('a nested .gitignore contributes no rules', () => {
    const ws = makeTempDir()
    writeTree(ws, { 'sub/.gitignore': '*.bak\n' })
    const engine = createIgnoreEngine(ws)
    expect(engine.isIgnored('sub/x.bak', false)).toBe(false)
  })

  it('sources report provenance', () => {
    const ws = makeTempDir()
    writeTree(ws, { '.agentcommitignore': '*.dump\n' })
    const engine = createIgnoreEngine(ws)
    expect(engine.sources).toEqual(['built-in defaults', '.agentcommitignore'])
    expect(createIgnoreEngine(makeTempDir()).sources).toEqual(['built-in defaults'])
  })

  it('init-created template is inert (no active rules)', () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    const engine = createIgnoreEngine(ws)
    expect(engine.isIgnored('.env', false)).toBe(false)
    expect(engine.isIgnored('anything/here.txt', false)).toBe(false)
  })
})
