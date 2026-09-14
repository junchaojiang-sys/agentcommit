import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import path from 'node:path'
import {
  buildRestorePlan, compareManifests, createPostSnapshot, createPreSnapshot,
  FSCasStore, initializeWorkspace, observeCurrent,
} from '@agentcommit/core'
import { makeTempDir, makeStateRoot, writeTree } from '../helpers.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), lstatSync: vi.fn(actual.lstatSync) }
})
afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const base = makeTempDir()
  const root = path.join(base, 'workspace')
  fs.mkdirSync(root)
  initializeWorkspace(root)
  writeTree(root, { 'safe.txt': 'before' })
  const stateRoot = makeStateRoot(base)
  const pre = await createPreSnapshot({ workspaceRoot: root, stateRoot })
  writeTree(root, { 'safe.txt': 'after' })
  const post = await createPostSnapshot({ workspaceRoot: root, stateRoot, sessionId: pre.session.id })
  return {
    base, stateRoot, options: {
      root, workspaceId: pre.session.workspaceId, sessionId: pre.session.id,
      pre: structuredClone(pre.manifest), post: structuredClone(post.postManifest),
      changeSet: compareManifests(pre.manifest, post.postManifest), cas: new FSCasStore(stateRoot),
    },
  }
}

describe('P2-A restore input boundaries', () => {
  it.each(['workspace', 'session', 'pre-workspace', 'post-workspace', 'pre-session', 'post-session', 'pre-ref', 'post-ref',
    'ignore-policy', 'builtin-policy', 'policy-shape', 'policy-version', 'cap-mirror', 'changeset-content', 'manifest-id'])('%s rejects before Current or CAS', async (kind) => {
    const { options } = await fixture()
    if (kind === 'workspace') options.workspaceId = 'wrong'
    if (kind === 'session') options.sessionId = 'wrong'
    if (kind === 'pre-workspace') options.pre.workspaceId = 'wrong'
    if (kind === 'post-workspace') options.post.workspaceId = 'wrong'
    if (kind === 'pre-session') options.pre.sessionId = 'wrong'
    if (kind === 'post-session') options.post.sessionId = 'wrong'
    if (kind === 'pre-ref') options.changeSet.preManifestRef = 'wrong'
    if (kind === 'post-ref') options.changeSet.postManifestRef = 'wrong'
    if (kind === 'ignore-policy') options.post.protectionPolicy.ignoreRules = ['different/**']
    if (kind === 'builtin-policy') options.post.protectionPolicy.builtinRules = ['different/**']
    if (kind === 'policy-shape') Reflect.deleteProperty(options.post.protectionPolicy, 'ignoreRules')
    if (kind === 'policy-version') {
      options.pre.protectionPolicy.builtinRulesVersion = 999
      options.post.protectionPolicy.builtinRulesVersion = 999
    }
    if (kind === 'cap-mirror') options.pre.maxFileSizeBytes++
    if (kind === 'changeset-content') options.changeSet.entries = []
    if (kind === 'manifest-id') options.pre.id = ''
    const has = vi.spyOn(options.cas, 'has')
    vi.mocked(fs.lstatSync).mockClear()
    vi.mocked(fs.readFileSync).mockClear()
    await expect(buildRestorePlan(options)).rejects.toMatchObject({ code: 'STATE_CORRUPT' })
    expect(fs.lstatSync).not.toHaveBeenCalled()
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(has).not.toHaveBeenCalled()
  })

  it('accepts matching manifests and a serialized ChangeSet', async () => {
    const { options } = await fixture()
    options.changeSet = JSON.parse(JSON.stringify(options.changeSet))
    const { plan } = await buildRestorePlan(options)
    expect(plan.actions.map((a) => a.path)).toEqual(['safe.txt'])
    expect(plan.blocked).toEqual([])
  })

  it.each(['../outside.txt', '..\\outside.txt', '.git/config', '.git\\config',
    './safe.txt', 'sub\\safe.txt', 'sub//safe.txt'])('never reads or stats invalid target %s', async (rel) => {
    const { base, options } = await fixture()
    writeTree(base, { 'outside.txt': 'external sentinel' })
    options.pre.files = options.pre.files.filter((f) => f.path === 'safe.txt').map((f) => ({ ...f, path: rel }))
    options.post.files = options.post.files.filter((f) => f.path === 'safe.txt').map((f) => ({ ...f, path: rel }))
    options.changeSet = compareManifests(options.pre, options.post)
    vi.mocked(fs.lstatSync).mockClear()
    vi.mocked(fs.readFileSync).mockClear()
    const { plan, current } = await buildRestorePlan(options)
    expect(plan.blocked).toHaveLength(1)
    expect(plan.actions).toEqual([])
    expect(current.size).toBe(0)
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(fs.lstatSync).not.toHaveBeenCalled()
    expect(() => observeCurrent(options.root, [rel])).toThrow()
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  it('rejects a parent junction before observing its external child', async () => {
    const { base, options } = await fixture()
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    writeTree(outside, { 'safe.txt': 'external sentinel' })
    fs.symlinkSync(outside, path.join(options.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const manifest of [options.pre, options.post]) {
      manifest.files = manifest.files.filter((f) => f.path === 'safe.txt').map((f) => ({ ...f, path: 'link/safe.txt' }))
    }
    options.changeSet = compareManifests(options.pre, options.post)
    vi.mocked(fs.lstatSync).mockClear()
    vi.mocked(fs.readFileSync).mockClear()
    const { plan, current } = await buildRestorePlan(options)
    expect(plan.blocked[0]?.reason).toMatch(/parent|link|junction/)
    expect(current.size).toBe(0)
    expect(fs.readFileSync).not.toHaveBeenCalled()
    expect(vi.mocked(fs.lstatSync).mock.calls.some(([p]) => String(p) === path.join(options.root, 'link/safe.txt'))).toBe(false)
  })

  it('unknown parent state is blocked; missing parent is safe absence', async () => {
    const { options } = await fixture()
    for (const manifest of [options.pre, options.post]) {
      manifest.files = manifest.files.filter((f) => f.path === 'safe.txt').map((f) => ({ ...f, path: 'missing/safe.txt' }))
    }
    options.changeSet = compareManifests(options.pre, options.post)
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    const { plan, current } = await buildRestorePlan(options)
    expect(plan.blocked).toHaveLength(1)
    expect(current.size).toBe(0)
    const next = await buildRestorePlan(options)
    expect(next.current.get('missing/safe.txt')).toEqual({ path: 'missing/safe.txt', exists: false })
  })
})
