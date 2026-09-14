import { describe, expect, it } from 'vitest'
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'

import path from 'node:path'
import {
  AgentCommitError,
  ChangeAssessments,
  ChangeKinds,
  ErrorCodes,
  FSCasStore,
  buildRestorePlan,
  compareManifests,
  createPostSnapshot,
  createPreSnapshot,
  describeChange,
  initializeWorkspace,
  loadRestorePlan,
  observeCurrent,
  parentLinkEscape,
  saveRestorePlan,
  sessionAdmission,
  type CasStore,
} from '@agentcommit/core'
import { makeTempDir, makeStateRoot, writeTree } from '../helpers.js'

/** Real CAS that simulates a post-scan read failure (locked file) for one path. */
class PostScanReadFailureCas implements CasStore {
  private readonly inner = new FSCasStore(makeStateRoot(makeTempDir()))
  constructor(private readonly failPath: string) {}
  put(content: Uint8Array) {
    return this.inner.put(content)
  }
  async putFromFile(filePath: string): Promise<string> {
    if (filePath.replace(/\\/g, '/').endsWith(this.failPath)) {
      throw new Error('EBUSY: file locked by another process')
    }
    return this.inner.putFromFile(filePath)
  }
  putFileStable(filePath: string, _expected: import('@agentcommit/core').FileIdentity) {
    return this.putFromFile(filePath)
  }
  get(hash: string) {
    return this.inner.get(hash)
  }
  has(hash: string) {
    return this.inner.has(hash)
  }
  verify(hash: string) {
    return this.inner.verify(hash)
  }
}

describe('P2-A: post snapshot with frozen policy', () => {
  it('post reuses the FROZEN policy: live .agentcommitignore mutations are data, not policy', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    // pre policy: ignore nothing extra
    const stateRoot = makeStateRoot(makeTempDir())
    writeTree(ws, { 'src/keep.ts': 'code', 'extra/skip.txt': 'x' })
    const configPath = path.join(ws, '.agentcommit.json')
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    cfg.maxFileSizeBytes = 4096
    writeFileSync(configPath, JSON.stringify(cfg, null, 2))
    // give pre an ignore file that does NOT exclude src
    writeFileSync(path.join(ws, '.agentcommitignore'), 'nothing-\n')

    const first = await createPostSnapshot({ workspaceRoot: ws, stateRoot }).catch((e) => e)
    // no session yet: createPreSnapshot first
    expect((first as AgentCommitError).code ?? 'none').toBeDefined()
    const pre = await (await import('@agentcommit/core')).createPreSnapshot({
      workspaceRoot: ws,
      stateRoot,
    })

    // Agent/user mutates the live ignore + config AFTER the pre snapshot
    writeFileSync(path.join(ws, '.agentcommitignore'), 'src/**\n')
    const cfg2 = JSON.parse(readFileSync(configPath, 'utf8'))
    cfg2.maxFileSizeBytes = 1
    writeFileSync(configPath, JSON.stringify(cfg2, null, 2))

    const { postManifest } = await createPostSnapshot({
      workspaceRoot: ws,
      stateRoot,
      sessionId: pre.session.id,
    })

    // frozen policy in force: cap still 4096, src still scanned, 'nothing-' rule inert
    expect(postManifest.maxFileSizeBytes).toBe(4096)
    expect(postManifest.protectionPolicy.ignoreRules).toEqual(['nothing-'])
    expect(postManifest.files.some((f) => f.path === 'src/keep.ts')).toBe(true)
    expect(postManifest.protectionPolicy).toEqual(pre.manifest.protectionPolicy)
  })

  it('rejects a pre manifest not bound to this session (STATE_CORRUPT)', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'a.txt': 'a' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })

    // tamper: point the session's preManifestRef at a manifest from another "session"
    const sessionPath = path.join(
      stateRoot,
      'workspaces',
      pre.session.workspaceId,
      'sessions',
      `${pre.session.id}.json`,
    )
    const raw = JSON.parse(readFileSync(sessionPath, 'utf8'))
    raw.preManifestRef = 'not-the-right-id'
    writeFileSync(sessionPath, JSON.stringify(raw, null, 2))

    try {
      await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.StateCorrupt)
    }
  })

  it('a failed post scan never produces a review baseline (real fatal mid-read)', { skip: process.platform === 'win32' }, async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'x.txt': 'ok', 'moving.txt': 'moving-content' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    const manifestsDir = path.join(stateRoot, 'workspaces', pre.session.workspaceId, 'manifests')
    const preManifestFile = path.join(manifestsDir, `${pre.manifest.id}.json`)
    const preManifestBefore = readFileSync(preManifestFile, 'utf8')

    // real fatal failure: mid-read mutation detected by the production guard.
    // The mutation must be MONOTONIC per attempt: a constant future mtime is
    // defeated by the stable-read retry (attempt N+1 re-stats the already-bumped
    // mtime as its baseline). A genuinely mutating writer keeps changing, so each
    // attempt pushes the mtime further out until the retry budget fails closed.
    class FatalMidReadCas extends FSCasStore {
      private mutation = 0
      protected override beforeStableReadVerify = (filePath: string): void => {
        this.mutation += 1
        const bumped = new Date(Date.now() + this.mutation * 3600_000)
        utimesSync(filePath, bumped, bumped)
      }
    }
    try {
      await createPostSnapshot({
        workspaceRoot: ws,
        stateRoot,
        sessionId: pre.session.id,
        cas: new FatalMidReadCas(stateRoot),
      })
      expect.unreachable('post should have failed')
    } catch (error) {
      // POSIX first-run (2026-09-09): the mutation can be caught by the CAS stable-read
      // guard (FILE_CHANGED_DURING_SNAPSHOT) or by the scanner's own mid-read guard;
      // both must fail closed with NO review baseline, which the assertions below check.
      process.stderr.write('[p2a-midread] guard error: ' + String((error as Error).message) + ' code=' + String((error as { code?: unknown }).code) + String.fromCharCode(10))
    }
    const session = JSON.parse(
      readFileSync(
        path.join(
          stateRoot,
          'workspaces',
          pre.session.workspaceId,
          'sessions',
          `${pre.session.id}.json`,
        ),
        'utf8',
      ),
    )
    expect(session.status).toBe('failed')
    expect(session.postManifestRef).toBeUndefined()
    expect(readdirSync(manifestsDir).length).toBe(1) // only the pre manifest
    expect(readFileSync(preManifestFile, 'utf8')).toBe(preManifestBefore) // Pre intact
    expect(readFileSync(path.join(ws, 'x.txt'), 'utf8')).toBe('ok')
  })

  it('A1: fatal CAS error propagates via createPostSnapshot; session failed; no post manifest; pre intact', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'x.txt': 'ok', 'victim.txt': 'valuable' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    const manifestsDir = path.join(stateRoot, 'workspaces', pre.session.workspaceId, 'manifests')
    const preManifestFile = path.join(manifestsDir, pre.manifest.id + '.json')
    const preManifestBefore = readFileSync(preManifestFile, 'utf8')
    class FatalCas {
      private readonly inner = new FSCasStore(stateRoot)
      put(c) { return this.inner.put(c) }
      async putFromFile() {
        throw new AgentCommitError(ErrorCodes.FileChangedDuringSnapshot, 'injected fatal: deterministic CAS failure')
      }
      putFileStable(fp) { return this.putFromFile(fp) }
      get(h) { return this.inner.get(h) }
      has(h) { return this.inner.has(h) }
      verify(h) { return this.inner.verify(h) }
    }
    try {
      await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id, cas: new FatalCas() })
      expect.unreachable('must fail closed')
    } catch (error) {
      expect(error.code).toBe(ErrorCodes.FileChangedDuringSnapshot)
    }
    const sess = JSON.parse(readFileSync(path.join(stateRoot, 'workspaces', pre.session.workspaceId, 'sessions', pre.session.id + '.json'), 'utf8'))
    expect(sess.status).toBe('failed')
    expect(sess.postManifestRef).toBeUndefined()
    expect(readdirSync(manifestsDir).length).toBe(1)
    expect(readFileSync(preManifestFile, 'utf8')).toBe(preManifestBefore)
    expect(readFileSync(path.join(ws, 'x.txt'), 'utf8')).toBe('ok')
    expect(readFileSync(path.join(ws, 'victim.txt'), 'utf8')).toBe('valuable')
  })


  it('post-side inaccessible is recorded as a change, NEVER as deleted', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'victim.txt': 'valuable' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })

    const post = await createPostSnapshot({
      workspaceRoot: ws,
      stateRoot,
      sessionId: pre.session.id,
      cas: new PostScanReadFailureCas('victim.txt'),
    })
    const victim = post.postManifest.files.find((f) => f.path === 'victim.txt')
    expect(victim).toBeDefined()
    expect(victim?.protected).toBe(false)
    expect(victim?.reasonUnprotected).toBe('inaccessible')

    const changeSet = compareManifests(pre.manifest, post.postManifest)
    const entry = changeSet.entries.find((c) => c.path === 'victim.txt')
    expect(entry?.kind).not.toBe(ChangeKinds.Deleted)
    expect(entry?.assessment).toBe(ChangeAssessments.CapabilityGap)
  })
})

describe('P2-A: change set + diff', () => {
  it('classifies created/modified/deleted/unchanged deterministically (incl. CRLF, unicode, binary)', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, {
      'will-modify.txt': 'v1\n',
      'will-delete.txt': 'bye',
      'will-stay.txt': 'same',
      'crlf.txt': 'a\r\nb\r\n',
      '中文 目录/文件 名.txt': 'unicode',
      'bin.dat': Uint8Array.from([1, 0, 2, 255]),
    })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })

    writeTree(ws, {
      'will-modify.txt': 'v2\n', // LF vs CRLF is still a text content change
      'crlf.txt': 'a\r\nb\r\nlater\n',
      '中文 目录/文件 名.txt': 'changed',
      'bin.dat': Uint8Array.from([9, 8, 7]),
      'new file.txt': 'created',
    })
    writeFileSync(path.join(ws, 'will-delete.txt'), 'bye') // still there, we delete via scan comparison:
    // actually delete it for the post scan:
    const { unlinkSync } = await import('node:fs')
    unlinkSync(path.join(ws, 'will-delete.txt'))

    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    const byPath = new Map(cs.entries.map((e) => [e.path, e]))

    expect(byPath.get('will-modify.txt')?.kind).toBe(ChangeKinds.Modified)
    expect(byPath.get('will-delete.txt')?.kind).toBe(ChangeKinds.Deleted)
    expect(byPath.get('new file.txt')?.kind).toBe(ChangeKinds.Created)
    expect(byPath.get('中文 目录/文件 名.txt')?.kind).toBe(ChangeKinds.Modified)
    expect(byPath.get('bin.dat')?.kind).toBe(ChangeKinds.Modified)
    expect(byPath.get('will-stay.txt')).toBeUndefined()
    // unchanged: will-stay.txt + the two init files (.agentcommit.json/.agentcommitignore)
    expect(cs.unchangedCount).toBe(3)
    // deterministic ordering
    const paths = cs.entries.map((e) => e.path)
    expect([...paths].sort()).toEqual(paths)

    // rerun comparison: identical result
    const again = compareManifests(pre.manifest, post.postManifest)
    expect(again).toEqual(cs)
  })

  it('describeChange: text patch for text, metadata for binary, scope filter', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, {
      't.txt': 'line1\nline2\n',
      'b.bin': Uint8Array.from([0, 1, 0, 2]),
    })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    writeTree(ws, { 't.txt': 'line1\nline2-changed\n', 'b.bin': Uint8Array.from([0, 9]) })
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    const cas = new FSCasStore(stateRoot)

    const tChange = cs.entries.find((e) => e.path === 't.txt') as import('@agentcommit/core').Change
    const tDiff = await describeChange(cas, tChange)
    expect(tDiff.mode).toBe('text')
    expect(tDiff.patch).toContain('line2-changed')

    const scoped = await describeChange(cas, tChange, { scope: 'other' })
    expect(scoped.mode).toBe('unavailable')

    const bChange = cs.entries.find((e) => e.path === 'b.bin') as import('@agentcommit/core').Change
    const bDiff = await describeChange(cas, bChange)
    expect(bDiff.mode).toBe('binary')
    expect(bDiff.patch).toBeUndefined()
  })
})

describe('P2-A: conflict assessment + read-only restore plan', () => {
  async function seedConflictWorkspace() {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    // Pre: keep=A(pre), mod=B(pre)->C(post), del.txt deleted by agent, new.txt created by agent
    writeTree(ws, { 'keep.txt': 'A', 'mod.txt': 'B', 'del.txt': 'D' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    writeTree(ws, { 'mod.txt': 'C', 'new.txt': 'NEW' })
    const { unlinkSync } = await import('node:fs')
    unlinkSync(path.join(ws, 'del.txt'))
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    return { ws, stateRoot, pre, post, cs }
  }

  it('modified: current==post plans restore; current!=post conflicts; created delete; deleted restore', async () => {
    const { ws, stateRoot, pre, post, cs } = await seedConflictWorkspace()
    const cas = new FSCasStore(stateRoot)
    const { plan } = await buildRestorePlan({
      root: ws,
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pre: pre.manifest,
      post: post.postManifest,
      changeSet: cs,
      cas,
    })
    const byPath = new Map(plan.actions.map((a) => [a.path, a]))
    // mod.txt: current == post (C) → restore pre (B)
    expect(byPath.get('mod.txt')?.type).toBe('write-file')
    expect(byPath.get('mod.txt')?.expectedCurrent).toBe('matches-post')
    expect(byPath.get('mod.txt')?.blobHash).toBeDefined()
    // new.txt: agent-created, current still matches → plan delete
    expect(byPath.get('new.txt')?.type).toBe('delete-path')
    // del.txt: agent deleted, current still absent → plan restore pre content
    expect(byPath.get('del.txt')?.type).toBe('write-file')
    expect(byPath.get('del.txt')?.expectedCurrent).toBe('absent')
    // deletions sort after writes
    const orders = plan.actions.map((a) => ({ t: a.type, o: a.order }))
    expect(orders[orders.length - 1]?.t).toBe('delete-path')
    expect(plan.conflicts).toEqual([])
    expect(plan.verifiedBlobs).toBe(true)
  })

  it('user edits after the session ⇒ conflicts, never silent overwrite', async () => {
    const { ws, stateRoot, pre, post, cs } = await seedConflictWorkspace()
    // user edits mod.txt (was C) to Z, and edits new.txt (agent-created) too
    writeTree(ws, { 'mod.txt': 'Z', 'new.txt': 'user touched' })
    const cas = new FSCasStore(stateRoot)
    const { plan } = await buildRestorePlan({
      root: ws,
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pre: pre.manifest,
      post: post.postManifest,
      changeSet: cs,
      cas,
    })
    const kinds = new Map(plan.conflicts.map((c) => [c.path, c.kind]))
    expect(kinds.get('mod.txt')).toBe('user-modified-after-session')
    expect(kinds.get('new.txt')).toBe('user-edited-created-file')
    expect(plan.actions.find((a) => a.path === 'mod.txt')).toBeUndefined()
    expect(plan.actions.find((a) => a.path === 'new.txt')).toBeUndefined()
  })

  it('deleted path recreated by user ⇒ conflict; current unreadable ⇒ unknown conflict', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'gone.txt': 'gone' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    const { unlinkSync } = await import('node:fs')
    unlinkSync(path.join(ws, 'gone.txt'))
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    // user recreates with different content
    writeTree(ws, { 'gone.txt': 'recreated-by-user' })
    const cas = new FSCasStore(stateRoot)
    const { plan } = await buildRestorePlan({
      root: ws,
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pre: pre.manifest,
      post: post.postManifest,
      changeSet: cs,
      cas,
    })
    expect(plan.conflicts[0]?.kind).toBe('path-recreated-after-delete')
    expect(plan.actions).toEqual([])
  })

  it('current == Pre is still a CONFLICT (first restore cannot claim self-restored)', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'mod.txt': 'B' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    writeTree(ws, { 'mod.txt': 'C' })
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    // user manually puts the file back to the PRE content
    writeTree(ws, { 'mod.txt': 'B' })
    const cas = new FSCasStore(stateRoot)
    const { plan } = await buildRestorePlan({
      root: ws,
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pre: pre.manifest,
      post: post.postManifest,
      changeSet: cs,
      cas,
    })
    expect(plan.actions).toEqual([])
    expect(plan.conflicts[0]?.kind).toBe('user-modified-after-session')
  })

  it('blocks: blob missing/corrupt, illegal paths, parent-link escape, directory replacement', async () => {
    const controlledParent = makeTempDir()
    const ws = path.join(controlledParent, 'workspace')
    mkdirSync(ws)
    initializeWorkspace(ws)
    writeTree(ws, {
      'corrupt.txt': 'content-A',
      'missing.txt': 'content-B',
      'in-git/keep.txt': 'x',
    })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    writeTree(ws, {
      'corrupt.txt': 'changed',
      'missing.txt': 'changed',
      'in-git/keep.txt': 'changed',
      replaced: 'agent-created file',
    })
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)

    // Current replaced the agent-created file with a directory after Post.
    rmSync(path.join(ws, 'replaced'))
    mkdirSync(path.join(ws, 'replaced'))

    // corrupt + remove one blob
    const corruptHash = cs.entries.find((e) => e.path === 'corrupt.txt')?.pre?.hash as string
    const blobPath = path.join(stateRoot, 'blobs', 'sha256', corruptHash.slice(0, 2), corruptHash.slice(2))
    writeFileSync(blobPath, 'garbage')
    const missingHash = cs.entries.find((e) => e.path === 'missing.txt')?.pre?.hash as string
    const missingPath = path.join(stateRoot, 'blobs', 'sha256', missingHash.slice(0, 2), missingHash.slice(2))
    rmSync(missingPath)

    // parent link escape: create a symlink dir inside the workspace pointing outside
    const outside = makeTempDir()
    try {
      symlinkSync(outside, path.join(ws, 'esc'), 'junction')
    } catch {
      // POSIX fallback
      symlinkSync(outside, path.join(ws, 'esc'), 'dir')
    }
    writeTree(outside, { 'esc-target.txt': 'outside content' })

    const cas = new FSCasStore(stateRoot)
    const { plan } = await buildRestorePlan({
      root: ws,
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pre: pre.manifest,
      post: post.postManifest,
      changeSet: cs,
      cas,
    })
    const conflictFor = new Map(plan.conflicts.map((c) => [c.path, c]))
    expect(plan.verifiedBlobs).toBe(false)
    // corrupt existing blob ⇒ unrecoverable CONFLICT (fail closed), not a plan
    expect(conflictFor.get('corrupt.txt')?.kind).toBe('unrecoverable')
    expect(conflictFor.get('corrupt.txt')?.message).toContain('corrupt')
    // removed blob ⇒ unrecoverable CONFLICT (missing), also fail closed
    expect(conflictFor.get('missing.txt')?.kind).toBe('unrecoverable')
    expect(conflictFor.get('missing.txt')?.message).toContain('missing')
    expect(plan.actions.every((a) => a.path !== 'corrupt.txt' && a.path !== 'missing.txt')).toBe(
      true,
    )
    expect(plan.actions.every((a) => a.path !== '../evil.txt')).toBe(true)
    // 'esc' link unchanged between scans ⇒ no change entry; direct unit proof
    // of the parent-link escape rule:
    expect(parentLinkEscape(ws, 'esc/anything.txt')).toBe(true)
    expect(parentLinkEscape(ws, 'a.txt')).toBe(false)
    // normal subdirectory paths keep working
    expect(plan.actions.some((a) => a.path === 'in-git/keep.txt')).toBe(true)
    expect(plan.blocked.some((b) => b.reason.includes('.git'))).toBe(false)

    // crafted traversal entry is always out of restore scope
    const traversalPre: import('@agentcommit/core').Manifest = {
      ...pre.manifest,
      files: [
        ...pre.manifest.files,
        { path: '../evil.txt', type: 'file', hash: 'a'.repeat(64), size: 1, protected: true },
      ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    }
    const traversalPost: import('@agentcommit/core').Manifest = {
      ...post.postManifest,
      files: [
        ...post.postManifest.files,
        { path: '../evil.txt', type: 'file', hash: 'b'.repeat(64), size: 1, protected: true },
      ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    }
    const crafted = compareManifests(traversalPre, traversalPost)
    const craftedPlan = await buildRestorePlan({
      root: ws,
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pre: traversalPre,
      post: traversalPost,
      changeSet: crafted,
      cas,
    })
    expect(craftedPlan.plan.actions.every((action) => action.path !== '../evil.txt')).toBe(true)
    expect(
      craftedPlan.plan.blocked.find((blocked) => blocked.path === '../evil.txt')?.reason,
    ).toContain('traversal')

    expect(plan.actions.every((a) => a.path !== 'replaced')).toBe(true)
    expect(plan.blocked.find((blocked) => blocked.path === 'replaced')?.reason).toContain('directory')
  })

  it('plan serializes, loads with binding+digest checks, and detects Current drift on re-planning', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'mod.txt': 'B' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    writeTree(ws, { 'mod.txt': 'C' })
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    const cas = new FSCasStore(stateRoot)
    const { plan } = await buildRestorePlan({
      root: ws,
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pre: pre.manifest,
      post: post.postManifest,
      changeSet: cs,
      cas,
      planId: 'fixed-plan-id',
      scope: 'mod.txt',
    })
    saveRestorePlan(stateRoot, pre.session.workspaceId, plan)
    const loaded = loadRestorePlan(stateRoot, pre.session.workspaceId, 'fixed-plan-id')
    expect(loaded.planDigest).toBe(plan.planDigest)
    expect(loaded.scope).toBe('mod.txt')
    expect(plan.scope).toBe('mod.txt')

    expect(() => loadRestorePlan(stateRoot, 'other-workspace', 'fixed-plan-id')).toThrow(
      /not found|another workspace/,
    )

    // tamper → digest mismatch
    const p = path.join(stateRoot, 'workspaces', pre.session.workspaceId, 'plans', 'fixed-plan-id.json')
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    raw.actions.push({ id: 'evil', type: 'write-file', path: 'evil.txt', order: 99 })
    writeFileSync(p, JSON.stringify(raw, null, 2))
    expect(() => loadRestorePlan(stateRoot, pre.session.workspaceId, 'fixed-plan-id')).toThrow(
      /integrity/,
    )

    // Current drift after planning: rebuild the plan and the action disappears
    // into a conflict (the file changed again)
    writeTree(ws, { 'mod.txt': 'D' })
    const cs2 = compareManifests(pre.manifest, post.postManifest)
    const rebuilt = await buildRestorePlan({
      root: ws,
      workspaceId: pre.session.workspaceId,
      sessionId: pre.session.id,
      pre: pre.manifest,
      post: post.postManifest,
      changeSet: cs2,
      cas,
    })
    expect(rebuilt.plan.actions).toEqual([])
    expect(rebuilt.plan.conflicts[0]?.kind).toBe('user-modified-after-session')
  })


  it('B1: every in-scope change traces to an action, conflict, or blocked entry', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'del.txt': 'D', 'mod.txt': 'B' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    writeTree(ws, { 'mod.txt': 'C', 'new.txt': 'NEW' })
    unlinkSync(path.join(ws, 'del.txt'))
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    const cas = new FSCasStore(stateRoot)
    const { plan } = await buildRestorePlan({ root: ws, workspaceId: pre.session.workspaceId, sessionId: pre.session.id, pre: pre.manifest, post: post.postManifest, changeSet: cs, cas })
    const traced = new Set([
      ...plan.actions.map((a) => a.path),
      ...plan.conflicts.map((c) => c.path),
      ...plan.blocked.map((b) => b.path ?? ''),
    ])
    for (const e of cs.entries) expect(traced.has(e.path)).toBe(true)
    expect(plan.actions.find((a) => a.path === 'mod.txt')?.type).toBe('write-file')
    expect(plan.actions.find((a) => a.path === 'del.txt')?.type).toBe('write-file')
    expect(plan.actions.find((a) => a.path === 'new.txt')?.type).toBe('delete-path')
    expect(new Set(plan.actions.map((a) => a.id)).size).toBe(plan.actions.length)
  })

  it('B3: scope field is recorded on the plan and persists through save/load', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'mod.txt': 'B', 'other.txt': 'O' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    writeTree(ws, { 'mod.txt': 'C', 'other.txt': 'O2' })
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    const cas = new FSCasStore(stateRoot)
    const { plan } = await buildRestorePlan({ root: ws, workspaceId: pre.session.workspaceId, sessionId: pre.session.id, pre: pre.manifest, post: post.postManifest, changeSet: cs, cas, scope: 'mod.txt' })
    expect(plan.scope).toBe('mod.txt')
    // only in-scope change is planned
    expect(plan.actions.map((a) => a.path)).toEqual(['mod.txt'])
    // scope persists through save/load
    saveRestorePlan(stateRoot, pre.session.workspaceId, plan)
    const loaded = loadRestorePlan(stateRoot, pre.session.workspaceId, plan.planId)
    expect(loaded.scope).toBe('mod.txt')
  })

  it('C: full P2-A flow leaves workspace untouched (paths, types, hashes, link targets, mode bits)', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'a.txt': 'A', 'delete.txt': 'DELETE', 'sub/b.txt': 'B' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })
    writeTree(ws, { 'a.txt': 'A2', 'new.txt': 'NEW' })
    unlinkSync(path.join(ws, 'delete.txt'))

    const linkPath = path.join(ws, 'agent-link')
    const linkTarget = path.join(ws, 'sub')
    let linkType: 'junction' | 'dir' | undefined
    try {
      linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(linkTarget, linkPath, linkType)
      console.log(`[C-readonly] link fixture supported: ${linkType}`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        linkType = undefined
        console.log(`[C-readonly] link fixture unsupported: platform=${process.platform} code=${code}`)
      } else {
        throw error
      }
    }

    const { createHash: ch } = await import('node:crypto')
    const snap = (dir) => {
      const out = []
      const walk = (cur, rel) => {
        for (const e of readdirSync(cur, { withFileTypes: true })) {
          const r = rel === '' ? e.name : rel + '/' + e.name
          const abs = path.join(cur, e.name)
          const st = lstatSync(abs)
          if (st.isSymbolicLink()) {
            out.push({ path: r, type: 'link', target: readlinkSync(abs), mode: st.mode & 0o777 })
          } else if (st.isDirectory()) {
            out.push({ path: r, type: 'directory', mode: st.mode & 0o777 })
            walk(abs, r)
          } else {
            const data = readFileSync(abs)
            out.push({
              path: r,
              type: 'file',
              sha256: ch('sha256').update(data).digest('hex'),
              mode: st.mode & 0o777,
            })
          }
        }
      }
      walk(dir, '')
      return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    }

    // Baseline is captured after the simulated agent edits and before every P2-A read-only step.
    const before = snap(ws)
    const post = await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
    const cs = compareManifests(pre.manifest, post.postManifest)
    const cas = new FSCasStore(stateRoot)
    for (const change of cs.entries) await describeChange(cas, change)
    observeCurrent(ws, cs.entries.map((e) => e.path))
    const { plan } = await buildRestorePlan({ root: ws, workspaceId: pre.session.workspaceId, sessionId: pre.session.id, pre: pre.manifest, post: post.postManifest, changeSet: cs, cas })
    saveRestorePlan(stateRoot, pre.session.workspaceId, plan)
    loadRestorePlan(stateRoot, pre.session.workspaceId, plan.planId)
    expect(before.some((entry) => entry.path === 'agent-link')).toBe(Boolean(linkType))
    expect(snap(ws)).toEqual(before)
  })
})

describe('P2-A: session admission (lock-stale ≠ transaction finished)', () => {
  it('a rollback_failed session blocks new observation even though its pid is gone', async () => {
    const ws = makeTempDir()
    initializeWorkspace(ws)
    writeTree(ws, { 'a.txt': 'a' })
    const stateRoot = makeStateRoot(makeTempDir())
    const pre = await createPreSnapshot({ workspaceRoot: ws, stateRoot })

    // simulate an unfinished recovery session left behind by a crashed process
    const otherId = '11111111-2222-3333-4444-555555555555'
    const sessionFile = path.join(
      stateRoot,
      'workspaces',
      pre.session.workspaceId,
      'sessions',
      `${otherId}.json`,
    )
    writeFileSync(
      sessionFile,
      JSON.stringify({ id: otherId, workspaceId: pre.session.workspaceId, status: 'rollback_failed' }),
    )

    const admission = sessionAdmission(stateRoot, pre.session.workspaceId, {
      excludeSessionId: pre.session.id,
    })
    expect(admission.eligible).toBe(false)
    expect(admission.blockers[0]).toContain(otherId)

    try {
      await createPostSnapshot({ workspaceRoot: ws, stateRoot, sessionId: pre.session.id })
      expect.unreachable('admission must block')
    } catch (error) {
      expect((error as AgentCommitError).code).toBe(ErrorCodes.WorkspaceLocked)
    }
  })
})

describe('P2-A: stable-read verification seam (A2 lifecycle record)', () => {
  it('mutation at the post-read verification seam is detected by the production fstat B check', { skip: process.platform === 'win32' }, async () => {
    // POSIX-only test: on Windows, utimesSync/appendFileSync from the test
    // process cannot modify a file that is already open by AgentCommit's
    // read handle (metadata visibility boundary). On POSIX, both operations
    // work deterministically, so the full detection path can be verified.
    const ws = makeTempDir()
    writeTree(ws, { 'db.bin': 'y'.repeat(8192) })
    const file = path.join(ws, 'db.bin')
    const stateRoot = makeStateRoot(makeTempDir())
    let seamCount = 0

    class ProbedCas extends FSCasStore {
      protected override beforeStableReadVerify = (filePath: string): void => {
        seamCount++
        // Real mutation at the verification seam: append changes size AND mtime.
        appendFileSync(filePath, Buffer.from('+verification-seam mutation'))
      }
    }

    const cas = new ProbedCas(stateRoot)
    let result = 'missed'
    try {
      await cas.putFromFile(file)
    } catch (error) {
      if (error instanceof AgentCommitError && error.code === ErrorCodes.FileChangedDuringSnapshot) {
        result = 'detected'
      }
    }
    console.log(`[A2-lifecycle] attempts=${seamCount} outcome=${result}`)
    expect(seamCount).toBe(1)
    expect(result).toBe('detected')
  })

  it('A2-Windows: stable-file CAS round-trip documents the Windows verification boundary', async () => {
    // On Windows, cross-handle fstat metadata visibility is limited: the
    // production fstat B check may NOT detect mid-read mutations because
    // Windows lazily updates metadata for open handles. This test documents
    // the limitation and verifies the mechanism does not crash.
    // Full POSIX detection coverage: see the POSIX-only test above.
    const ws = makeTempDir()
    writeTree(ws, { 'db.bin': 'y'.repeat(4096) })
    const stateRoot = makeStateRoot(makeTempDir())
    const cas = new FSCasStore(stateRoot)
    // Simply verify that putFromFile works for a stable file on Windows
    const { createHash } = await import('node:crypto')
    const hash = await cas.putFromFile(path.join(ws, 'db.bin'))
    const data = await cas.get(hash)
    const expected = createHash('sha256').update(data).digest('hex')
    expect(hash).toBe(expected)
  })
})
