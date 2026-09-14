import { lstatSync, realpathSync, writeFileSync, type Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  blobsRoot,
  buildProtectionSummary,
  inspectSession,
  listWorkspaceSessions,
  loadRestoreJournal,
  readLock,
  resolveStateRoot,
  resolveWorkspace,
  SessionStatus,
  sessionAdmission,
  type Manifest,
  type RestoreJournal,
  type Session,
} from '@agentcommit/core'

/**
 * Read-only workspace/state diagnosis for `doctor` (P4).
 *
 * Hard rules (frozen):
 * - never mutates the workspace, the state root, or any Session/Journal state;
 * - never guesses an uncertain state into "safe to continue" — uncertain ⇒ blocked;
 * - never deletes locks/sessions or fabricates a Post (that is out of scope and
 *   remains a P4 product decision, see docs/P4_RUNNING_DISPOSITION_PROPOSAL.md).
 */

export type DoctorSeverity = 'info' | 'attention' | 'blocked'
export type DoctorOverall = 'ok' | 'attention' | 'blocked'

export interface DoctorFinding {
  code: string
  severity: DoctorSeverity
  /**
   * What was found. Local detail only: it may embed raw session ids, pids, and
   * truncated error text. The shared report never carries this text; it is
   * replaced by the fixed per-code description in SAFE_FINDING_TEXT.
   */
  what: string
  /** What it affects. */
  impact: string
  /** Actions that must not be taken while this holds. */
  blockedActions: string[]
  /** Existing safe entry points the user can use today. */
  safeEntries: string[]
  /** What a human must confirm before further action ('' when none). */
  humanConfirmation: string
  /**
   * Raw session id this finding is about, when session-scoped. Local detail
   * only; the shared report maps it to an anonymous id or omits it.
   */
  sessionId?: string
  /**
   * Numeric-only details safe to share (counts, pids). Keys are fixed per
   * finding code; values are validated to be finite numbers before sharing.
   */
  counters?: Record<string, number>
}

export interface DoctorDiagnosis {
  overall: DoctorOverall
  findings: DoctorFinding[]
}

export interface DoctorResult {
  node: string
  platform: NodeJS.Platform
  arch: string
  workspaceRoot: string
  stateRoot: string
  lock: { state: 'absent' | 'readable' | 'unreadable'; sessionId?: string; pidAlive?: boolean; sameHost?: boolean }
  admission: { eligible: boolean; blockers: string[] }
  sessions: Array<{ id: string; status: string; startedAt: string; journal?: { status: string; attempts: number; receipts: number } }>
  diagnosis: DoctorDiagnosis
  boundaries: string[]
}

const NON_TERMINAL_EXPLANATIONS: Record<string, { what: string; impact: string; safe: string[] }> = {
  [SessionStatus.Ready]: {
    what: 'A session was created but its pre-scan never finished.',
    impact: 'The session owns the workspace transaction but protects nothing yet.',
    safe: ['agentcommit unlock --session <id> (interactive, requires proof the holder pid is dead and local)'],
  },
  [SessionStatus.Snapshot]: {
    what: 'A session captured its pre-snapshot but never started or finished the agent run.',
    impact: 'The pre-snapshot and lock still own the workspace transaction.',
    safe: ['agentcommit unlock --session <id> (interactive, requires proof the holder pid is dead and local)'],
  },
  [SessionStatus.Running]: {
    what: 'A wrapper was interrupted while its agent session was still marked running.',
    impact: 'No Post exists; the workspace transaction is still owned by this session.',
    safe: ['agentcommit unlock --session <id> (interactive, requires proof the holder pid is dead and local)'],
  },
  [SessionStatus.Review]: {
    what: 'A finished session is waiting for review.',
    impact: 'Review actions are available; the workspace stays locked against new runs.',
    safe: ['agentcommit status', 'agentcommit diff', 'agentcommit commit', 'agentcommit rollback'],
  },
  [SessionStatus.RollbackFailed]: {
    what: 'A rollback failed mid-way; its restore plan and journal are retained.',
    impact: 'The session must not be marked rolled back; retry is resumable and idempotent.',
    safe: ['agentcommit rollback (resumes pending actions, skips verified ones)'],
  },
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function finding(code: string, severity: DoctorSeverity, what: string, impact: string,
  blockedActions: string[] = [], safeEntries: string[] = [], humanConfirmation = '', sessionId?: string): DoctorFinding {
  return { code, severity, what, impact, blockedActions, safeEntries, humanConfirmation, ...(sessionId !== undefined ? { sessionId } : {}) }
}

function journalSummary(stateRoot: string, workspaceId: string, session: Session, findings: DoctorFinding[]): DoctorResult['sessions'][number]['journal'] {
  let journal: RestoreJournal | undefined
  try {
    journal = loadRestoreJournal(stateRoot, workspaceId, session.id)
  } catch {
    findings.push(Object.assign(
      finding('journal-corrupt', 'blocked',
        `Restore journal for session ${session.id} exists but cannot be parsed.`,
        'Recovery admission fails closed; commit/rollback/unlock flows that need the journal refuse.',
        ['Do not delete or hand-edit the journal.', 'Do not mark the session finished by hand.'],
        ['agentcommit doctor (this diagnosis)', 'Preserve the state directory for support/analysis.'],
        'Decide how to preserve/inspect the corrupted journal with human review; no automated repair exists.',
        session.id),
      { counters: { attempts: 0, receipts: 0 } }))
    return { status: 'corrupt', attempts: 0, receipts: 0 }
  }
  if (journal === undefined) return undefined
  const attempts = journal.attempts?.length ?? 0
  const receipts = journal.completedReceipts?.length ?? 0
  if (journal.status === 'partial' || journal.status === 'executing' || (journal.status === 'prepared' && attempts > 0)) {
    findings.push(Object.assign(
      finding('restore-incomplete', 'attention',
        `Session ${session.id} has an interrupted restore (journal status=${journal.status}, attempts=${attempts}, completedReceipts=${receipts}).`,
        'Some restore actions may have already executed; the session still owns the transaction.',
        ['Do not hand-edit the workspace to "finish" the restore.', 'Do not start new agent runs in this workspace.'],
        ['agentcommit rollback (deterministic resume: skips verified actions, continues pending ones)'],
        '', session.id),
      { counters: { attempts, receipts } }))
  }
  return { status: journal.status, attempts, receipts }
}

/** Same SHA-256 address contract as the CAS store (packages/core fs-cas). */
const SHA256_HEX = /^[0-9a-f]{64}$/
/**
 * Recorded link types doctor knows how to restore from a recorded target;
 * they are protected via that target, never via a CAS blob.
 * 'reparse' is deliberately NOT exempt: an unidentified reparse point carries
 * no known-target guarantee at the doctor layer, so it fails closed below.
 */
const LINK_RECORD_TYPES = new Set(['symlink', 'junction'])

/**
 * Check EVERY required CAS reference in a manifest (P4 review issue 04).
 * A reference is required iff the record is protected and is not a recorded
 * symlink/junction (their targets are kept in the manifest, never followed
 * into the CAS). A protected record of any other type — including 'reparse',
 * whose reparse semantics are unknown here — is fail-closed: a valid-looking
 * hash must never buy it ordinary-file health.
 * Required ordinary-file references must carry a hash matching the CAS
 * SHA-256 hex contract, and the blob path must resolve — WITHOUT following
 * links — to a regular file: ENOENT is missing, a non-regular entry (e.g. a
 * directory squatting on the blob path) or an unconfirmable one is blocked.
 * This is an EXISTENCE/type check only: it does not re-verify blob content
 * hashes.
 */
function casBlobsExist(stateRoot: string, label: string, manifest: Manifest, findings: DoctorFinding[]): void {
  const shard = blobsRoot(stateRoot) // layout: <stateRoot>/blobs/sha256/<ab>/<cdef…>
  // P4 review issue 04: EVERY required reference is checked (no coverage cap);
  // the per-finding counters report the checked range, and the check is an
  // EXISTENCE/type check only — blob content hashes are not re-verified here.
  let missing = 0
  let invalid = 0
  let irregular = 0
  let unknownType = 0
  let checked = 0
  for (const record of manifest.files ?? []) {
    if (!record || typeof record !== 'object' || record.protected !== true) continue
    const type = (record as { type?: unknown }).type
    // Recorded symlink/junction targets are protected via the manifest, never
    // via a CAS blob; any other protected type (reparse included) falls through
    // to the fail-closed unknown-type branch below.
    if (typeof type === 'string' && LINK_RECORD_TYPES.has(type)) continue
    checked++
    if (type !== 'file') {
      // Unknown/unsupported/corrupt type on a protected entry is never treated
      // as a healthy ordinary file, even when it carries a valid hash.
      unknownType++
      continue
    }
    const hash = (record as { hash?: unknown }).hash
    if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
      invalid++
      continue
    }
    const blob = path.join(shard, hash.slice(0, 2), hash.slice(2))
    let stats: Stats
    try {
      stats = lstatSync(blob) // lstat, never follow: a CAS address must itself be a regular file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing++
      else irregular++ // unreadable/uncertain is never healthy
      continue
    }
    if (!stats.isFile()) irregular++ // e.g. a directory occupying the blob path
  }
  if (unknownType > 0) {
    findings.push(Object.assign(
      finding('cas-record-type-unknown', 'blocked',
        `${unknownType} of ${checked} protected record(s) in the latest session's ${label} manifest carry a type that is neither a known link type nor an ordinary file (type check only; blob content hashes are not re-verified here).`,
        'Restore cannot be planned or trusted for those paths; a valid-looking hash never makes an unconfirmable record healthy.',
        ['Do not run rollback expecting a complete restore.', 'Do not hand-edit the manifest to "fix" the type.'],
        ['agentcommit doctor (this diagnosis)'],
        'Inspect the manifest with human review; the recorded type must come from a real scan, not a hand-edit.'),
      { counters: { unknownTypeRecords: unknownType, checked } }))
  }
  if (irregular > 0) {
    findings.push(Object.assign(
      finding('cas-blob-not-regular', 'blocked',
        `${irregular} of ${checked} CAS blob path(s) referenced by the latest session's ${label} manifest exist but are not regular files, or their file type could not be confirmed (link-free existence/type check; blob content hashes are not re-verified here).`,
        'A blob address occupied by a directory, link, or unreadable entry cannot be trusted as restorable content.',
        ['Do not run rollback expecting a complete restore.', 'Do not delete or hand-edit the CAS store to "fix" the entry.'],
        ['agentcommit doctor (this diagnosis)'],
        'Investigate how the blob path was replaced; restore from backup or accept the loss explicitly with human review.'),
      { counters: { irregular, checked } }))
  }
  if (invalid > 0) {
    findings.push(Object.assign(
      finding('cas-hash-invalid', 'blocked',
        `${invalid} of ${checked} required protected-file CAS references in the latest session's ${label} manifest do not carry a valid SHA-256 hash.`,
        'The reference cannot be resolved to a CAS address; restore cannot be planned or trusted for those paths.',
        ['Do not run rollback expecting a complete restore.', 'Do not hand-edit the manifest to "fix" the hash.'],
        ['agentcommit doctor (this diagnosis)'],
        'Inspect the manifest with human review; the correct hash must come from the recorded content, not a hand-edit.'),
      { counters: { invalid, checked } }))
  }
  if (missing > 0) {
    findings.push(Object.assign(
      finding('cas-blob-missing', 'blocked',
        `${missing} of ${checked} CAS blobs referenced by the latest session's ${label} manifest are missing from the state root (existence check; blob content hashes are not re-verified here).`,
        'Rollback cannot be marked successful with missing blobs; restore would refuse or fail.',
        ['Do not run rollback expecting a complete restore.', 'Do not delete the session as a "fix".'],
        ['agentcommit doctor (this diagnosis)'],
        'Investigate how blobs were removed; restore from backup or accept the loss explicitly with human review.'),
      { counters: { missing, checked } }))
  }
}

/** Classify the workspace + state root. Strictly read-only. */
export function diagnoseWorkspace(input: { workspaceRoot: string; stateRoot?: string }): DoctorResult {
  const findings: DoctorFinding[] = []
  const stateRoot = input.stateRoot ?? resolveStateRoot()
  const { root, config } = resolveWorkspace(input.workspaceRoot)
  const workspaceId = config.workspaceId

  // Lock state (never modified here).
  const lock = readLock(stateRoot, workspaceId)
  let lockOut: DoctorResult['lock'] = { state: lock.state }
  if (lock.state === 'readable') {
    const sameHost = lock.content.hostname === os.hostname()
    const alive = sameHost ? pidAlive(lock.content.pid) : true // foreign host: cannot prove death locally
    lockOut = { state: 'readable', sessionId: lock.content.sessionId, pidAlive: alive, sameHost }
    if (!sameHost) {
      findings.push(finding('lock-foreign-host', 'blocked',
        `The workspace lock was created on a different host (session ${lock.content.sessionId}).`,
        'Ownership cannot be proven locally; every transactional command fails closed.',
        ['Do not delete the lock file.'], ['agentcommit doctor (this diagnosis)'],
        'Resolve on the host that holds the lock, or manually verify that host no longer runs AgentCommit.',
        lock.content.sessionId))
    } else if (alive) {
      findings.push(Object.assign(
        finding('lock-held-live', 'attention',
          `The workspace lock is held by a live local process (pid ${lock.content.pid}, session ${lock.content.sessionId}).`,
          'New runs are refused while the holder lives.',
          ['Do not unlock a live holder.'], ['Wait for the holding AgentCommit process to finish.'], '',
          lock.content.sessionId),
        { counters: { holderPid: lock.content.pid } }))
    }
    // A readable + dead lock pairs with the running/dead session finding below.
  } else if (lock.state === 'unreadable') {
    findings.push(finding('lock-unreadable', 'blocked',
      'The workspace lock file exists but cannot be parsed.',
      'Ownership cannot be proven; every transactional command fails closed.',
      ['Do not delete the lock file by hand.'], ['agentcommit doctor (this diagnosis)'],
      'Manually inspect the lock file; removal requires human confirmation of a dead holder.'))
  }

  // Sessions.
  let sessions: Session[] = []
  try {
    sessions = listWorkspaceSessions({ workspaceRoot: root, stateRoot })
  } catch {
    findings.push(finding('sessions-unreadable', 'blocked',
      'The persisted sessions cannot be enumerated or fail strict validation.',
      'Recovery admission fails closed; run/status/commit/rollback all refuse.',
      ['Do not hand-edit or delete session files.'], ['agentcommit doctor (this diagnosis)'],
      'Inspect the state directory with human review; the failing record names the problem.'))
  }

  const sessionOut: DoctorResult['sessions'] = []
  for (const session of sessions) {
    const journal = journalSummary(stateRoot, workspaceId, session, findings)
    sessionOut.push({ id: session.id, status: session.status, startedAt: session.startedAt, journal })

    const explanation = NON_TERMINAL_EXPLANATIONS[session.status]
    if (session.status === SessionStatus.Running) {
      const deadHolder = lock.state === 'readable' && lock.content.sessionId === session.id && sameHostDead(lock)
      if (deadHolder) {
        findings.push(finding('session-running-pid-dead', 'blocked',
          `Session ${session.id} is marked running but its wrapper process is dead (proved by the local lock holder check).`,
          'No Post exists; the pre-snapshot and journal own the transaction. New runs are refused.',
          ['Do not fabricate a Post or mark the session finished.', 'Do not delete the session or the lock to "unblock".'],
          ['agentcommit unlock --session ' + session.id + ' (interactive; proves pid death + host match, releases only the lock; it does not end the session and does not restore new-run admission)'],
          'Confirm the agent and all its children actually stopped before unlocking — that confirmation is a precondition of unlock, never a consequence of it. Unlock releases only the lock and does not end the session: the Session stays running and still blocks new runs (sessionAdmission keeps refusing). How a crashed-run session is dispositioned is a pending independent product decision; do not bypass it by deleting records or marking the session failed by hand.',
          session.id))
      } else {
        findings.push(finding('session-running-live-or-unproven', 'attention',
          `Session ${session.id} is marked running and its holder cannot be proven dead locally.`,
          'The session may genuinely still be running; new runs are refused.',
          ['Do not unlock while the holder may be alive.'], ['Wait for the wrapper to finish or verify the holder process.'],
          'Confirm whether the wrapper process is still alive on this host.', session.id))
      }
    } else if (session.status === SessionStatus.Snapshot || session.status === SessionStatus.Ready) {
      findings.push(finding('session-unfinished-setup', 'attention',
        `Session ${session.id}: ${explanation?.what ?? 'unfinished setup state'}.`,
        explanation?.impact ?? 'The session owns the workspace transaction.', ['Do not hand-edit session state.'],
        explanation?.safe ?? [], '', session.id))
    } else if (session.status === SessionStatus.Review) {
      findings.push(finding('session-review-pending', 'attention',
        `Session ${session.id} finished and waits for review.`,
        'The workspace keeps its lock against new runs until the session is committed or rolled back.',
        [], explanation?.safe ?? ['agentcommit status', 'agentcommit diff', 'agentcommit commit', 'agentcommit rollback'], '',
        session.id))
    } else if (session.status === SessionStatus.RollbackFailed) {
      findings.push(finding('session-rollback-failed', 'attention',
        `Session ${session.id}: ${explanation?.what ?? 'a rollback failed mid-way; plan and journal retained'}.`,
        explanation?.impact ?? 'The session must not be marked rolled back; retry is resumable and idempotent.',
        ['Do not mark the session rolled back by hand.'],
        explanation?.safe ?? ['agentcommit rollback (resumes pending actions, skips verified ones)'], '',
        session.id))
    } else if (session.status === SessionStatus.Abandoned) {
      findings.push(finding('session-abandoned', 'info',
        `Session ${session.id} was explicitly abandoned via resolve --abandon (tracking terminated; evidence preserved).`,
        'It is terminal: not a commit, not a rollback; its outcome was never measured. While it is the newest session, restore refuses rather than silently selecting an older one.',
        [], ['agentcommit doctor (this diagnosis)'], '', session.id))
    }
  }

  // Admission + manifest/CAS sanity for the latest session.
  const admission = sessionAdmission(stateRoot, workspaceId)
  for (const blocker of admission.blockers) {
    if (/corrupt|invalid|unknown status|unreadable/i.test(blocker)) {
      findings.push(finding('state-anomaly', 'blocked',
        `Recovery admission reports an unreadable or unknown state record: ${blocker}.`,
        'Fail-closed: no new transaction may start until a human resolves the record.',
        ['Do not delete the record.'], ['agentcommit doctor (this diagnosis)'],
        'Inspect the named record; removal or repair needs an explicit, authorized product decision.'))
    }
  }
  const latest = sessions[0]
  if (latest) {
    try {
      // Single core entry point: inspectSession loads the referenced Pre/Post
      // manifests AND proves the full Session binding (manifest.id === ref,
      // workspaceId, sessionId) plus the frozen Pre/Post policy contract
      // (validateRestorePlanInputs). Doctor must never re-derive or bypass
      // those checks before it inspects the CAS or summarizes protection.
      const inspected = inspectSession({ workspaceRoot: root, stateRoot, sessionId: latest.id })
      let checkedAny = false
      if (inspected.pre) {
        casBlobsExist(stateRoot, 'pre', inspected.pre, findings)
        checkedAny = true
      }
      if (inspected.post) {
        casBlobsExist(stateRoot, 'post', inspected.post, findings)
        checkedAny = true
      }
      if (checkedAny) {
        const summaryManifest = inspected.post ?? inspected.pre!
        const summary = buildProtectionSummary(summaryManifest)
        const gaps = (summary.unprotectedPaths?.length ?? 0) + (summary.ignoredEntries ?? 0) + (summary.unreadableEntries ?? 0)
        if (gaps > 0) {
          findings.push(Object.assign(
            finding('protection-gaps', 'info',
              `The latest manifest records protection gaps: ${summary.unprotectedPaths?.length ?? 0} unprotected path(s), ${summary.ignoredEntries ?? 0} ignored, ${summary.unreadableEntries ?? 0} unreadable.`,
              'Those paths are not protected: rollback cannot restore them, and "fully reversible" never holds while they exist.',
              [], ['agentcommit run prints the full Protection Summary with per-path reasons before every session.'], ''),
            { counters: {
              unprotectedPaths: summary.unprotectedPaths?.length ?? 0,
              ignoredEntries: summary.ignoredEntries ?? 0,
              unreadableEntries: summary.unreadableEntries ?? 0,
            } }))
        }
      }
    } catch (error) {
      findings.push(finding('manifest-anomaly', 'blocked',
        `The latest session's manifest cannot be loaded or fails binding validation: ${(error as Error).message.slice(0, 160)}`,
        'Diff/restore planning for that session refuses; admission may fail closed.',
        ['Do not hand-edit manifests.'], ['agentcommit doctor (this diagnosis)'],
        'Inspect the manifest with human review; repair is not automated.'))
    }
  }

  // Platform notes.
  if (process.platform === 'win32') {
    findings.push(finding('platform-win32-notes', 'info',
      'Windows (static capability notes): POSIX rwx-bit restore is not verified here (no ACL promise); creating file/dir symlinks needs Developer Mode or admin privilege (junctions work unprivileged).',
      'Verification boundary: rwx-bit restore and symlink capability are bounded by the platform this diagnosis actually ran on. Cross-platform behavior is verified by GitHub-hosted CI on Windows/Linux/macOS (Node 22/24); local manual development has been primarily Windows, so Linux/macOS are not widely verified on user machines.',
      [], [], ''))
  } else {
    findings.push(finding('platform-posix-notes', 'info',
      'POSIX platform (static capability notes): rwx-bit restore and symlink scanning branches are implemented for POSIX.',
      'Verification boundary: these are capability statements only — they are bounded by the platform this diagnosis actually ran on. Cross-platform behavior is verified by GitHub-hosted CI on Windows/Linux/macOS (Node 22/24); wide verification on user machines is not claimed.',
      [], [], ''))
  }

  const overall: DoctorOverall = findings.some(f => f.severity === 'blocked')
    ? 'blocked'
    : findings.some(f => f.severity === 'attention') ? 'attention' : 'ok'
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    workspaceRoot: root,
    stateRoot,
    lock: lockOut,
    admission,
    sessions: sessionOut,
    diagnosis: { overall, findings },
    boundaries: [
      'No native sandbox or power-loss transaction guarantee.',
      'Agent binaries have not been validated by this command.',
      'CAS stores protected file content in plaintext.',
      'The CAS check here is an EXISTENCE/type check with a reported range; content integrity is enforced by the read path, which re-hashes every byte it returns.',
      'This diagnosis is read-only; it never repairs, deletes, or unlocks anything.',
    ],
  }
}

function sameHostDead(lock: { content: { hostname: string; pid: number } } & Record<string, unknown>): boolean {
  if (lock.content.hostname !== os.hostname()) return false
  return !pidAlive(lock.content.pid)
}

/**
 * Create the doctor report file exclusively (P4 review issue 01).
 *
 * Hard rules:
 * - never truncates or replaces an existing file, directory, or link ('wx' flag);
 * - never writes into protected locations: the state root, the workspace's
 *   `.git`, or the workspace `.agentcommit.json` config — checked after
 *   resolving symlinks/junctions on the nearest existing ancestor so a parent
 *   link that physically aliases a protected location is also refused
 *   (Windows compares paths case-insensitively; declared protected paths are
 *   enforced even when they do not exist yet);
 * - this closes the truncate-on-existing hazard and the alias bypass; it is not
 *   a sandbox and does not eliminate TOCTOU races on the final path.
 */
/**
 * Same-path or descendant test. Windows path semantics are case-insensitive
 * (realpathSync does NOT fold the input's letter case to the on-disk form
 * there, so strict string comparison is insufficient); POSIX stays
 * case-sensitive.
 */
function isSamePathOrChild(candidate: string, base: string): boolean {
  const fold = process.platform === 'win32'
  const c = fold ? candidate.toLowerCase() : candidate
  const b = fold ? base.toLowerCase() : base
  return c === b || c.startsWith(b + path.sep)
}

/**
 * Canonicalize a possibly-not-yet-existing path: real-path its deepest
 * existing ancestor, then re-attach the missing tail components (basename
 * included). Both the report candidate and declared protected paths go through
 * this same helper, so an alias (junction/dir symlink) on either side resolves
 * identically before comparison. Only ENOENT means "component does not exist"
 * and walks up to the parent; every other error (ENOTDIR, EACCES, …) and an
 * unreachable filesystem root propagate — an unconfirmed path is never
 * returned as canonical (fail closed).
 */
function canonicalizeNearestExisting(p: string): string {
  const tail: string[] = []
  let cur = p
  for (;;) {
    try {
      return tail.length > 0 ? path.join(realpathSync(cur), ...tail) : realpathSync(cur)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      tail.unshift(path.basename(cur))
      const parent = path.dirname(cur)
      if (parent === cur) {
        throw new Error(`cannot canonicalize path: no existing ancestor found before the filesystem root`)
      }
      cur = parent
    }
  }
}

export function writeDoctorReportExclusively(
  target: string,
  content: string,
  protectedPaths: Array<{ label: string; p: string }>,
): void {
  const resolved = canonicalizeNearestExisting(path.resolve(target))
  for (const { label, p } of protectedPaths) {
    // Same canonicalization on both sides: a protected path that does not
    // exist yet still compares against the resolved candidate, so a report
    // cannot squat where the protected directory belongs, and parent links
    // that physically alias a protected location are refused.
    const canonicalProtected = canonicalizeNearestExisting(path.resolve(p))
    if (isSamePathOrChild(resolved, canonicalProtected)) {
      throw new Error(
        `report path refused: it resolves into a protected ${label} (${label === 'workspace config' ? 'file' : 'directory'}); choose a new path outside it`,
      )
    }
  }
  const abs = path.resolve(target)
  // 'wx' fails with EEXIST for any existing entry (file, dir, or link) — the
  // report is only ever a newly created file, never an overwrite.
  writeFileSync(abs, content, { flag: 'wx' })
}

/**
 * Fixed, share-safe text for every finding code the doctor can emit.
 * The shared report NEVER carries the local `what`/`impact`/… free text (it can
 * embed raw session ids, pids, blocker strings, and truncated error messages
 * with absolute path prefixes); each known code is re-described here with a
 * static string. Numeric specifics travel as validated `counters`; the affected
 * session travels as an anonymous reference. This table is the primary defense
 * — not username/path substitution.
 */
const SAFE_FINDING_TEXT: Record<string, Omit<DoctorFinding, 'code' | 'severity' | 'sessionId' | 'counters'>> = {
  'journal-corrupt': {
    what: 'A restore journal for a recorded session exists but cannot be parsed.',
    impact: 'Recovery admission fails closed; commit/rollback/unlock flows that need the journal refuse.',
    blockedActions: ['Do not delete or hand-edit the journal.', 'Do not mark the session finished by hand.'],
    safeEntries: ['agentcommit doctor (this diagnosis)', 'Preserve the state directory for support/analysis.'],
    humanConfirmation: 'Decide how to preserve/inspect the corrupted journal with human review; no automated repair exists.',
  },
  'restore-incomplete': {
    what: 'A session has an interrupted restore (counters: attempts, completedReceipts).',
    impact: 'Some restore actions may have already executed; the session still owns the transaction.',
    blockedActions: ['Do not hand-edit the workspace to "finish" the restore.', 'Do not start new agent runs in this workspace.'],
    safeEntries: ['agentcommit rollback (deterministic resume: skips verified actions, continues pending ones)'],
    humanConfirmation: '',
  },
  'cas-blob-missing': {
    what: 'CAS blobs referenced by the latest session manifest are missing from the state root (counters: missing, checked; existence check only, blob content hashes are not re-verified).',
    impact: 'Rollback cannot be marked successful with missing blobs; restore would refuse or fail.',
    blockedActions: ['Do not run rollback expecting a complete restore.', 'Do not delete the session as a "fix".'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Investigate how blobs were removed; restore from backup or accept the loss explicitly with human review.',
  },
  'cas-hash-invalid': {
    what: 'Required protected-file CAS references in the latest session manifest do not carry a valid SHA-256 hash (counters: invalid, checked).',
    impact: 'The reference cannot be resolved to a CAS address; restore cannot be planned or trusted for those paths.',
    blockedActions: ['Do not run rollback expecting a complete restore.', 'Do not hand-edit the manifest to "fix" the hash.'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Inspect the manifest with human review; the correct hash must come from the recorded content, not a hand-edit.',
  },
  'cas-record-type-unknown': {
    what: 'Protected records in the latest session manifest carry a type that is neither a known link type nor an ordinary file; a valid-looking hash never makes them healthy (counters: unknownTypeRecords, checked; type check only, blob content hashes are not re-verified).',
    impact: 'Restore cannot be planned or trusted for those paths.',
    blockedActions: ['Do not run rollback expecting a complete restore.', 'Do not hand-edit the manifest to "fix" the type.'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Inspect the manifest with human review; the recorded type must come from a real scan, not a hand-edit.',
  },
  'cas-blob-not-regular': {
    what: 'CAS blob paths referenced by the latest session manifest exist but are not regular files, or their file type could not be confirmed (counters: irregular, checked; link-free existence/type check only, blob content hashes are not re-verified).',
    impact: 'A blob address occupied by a directory, link, or unreadable entry cannot be trusted as restorable content.',
    blockedActions: ['Do not run rollback expecting a complete restore.', 'Do not delete or hand-edit the CAS store to "fix" the entry.'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Investigate how the blob path was replaced; restore from backup or accept the loss explicitly with human review.',
  },
  'lock-foreign-host': {
    what: 'The workspace lock was created on a different host.',
    impact: 'Ownership cannot be proven locally; every transactional command fails closed.',
    blockedActions: ['Do not delete the lock file.'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Resolve on the host that holds the lock, or manually verify that host no longer runs AgentCommit.',
  },
  'lock-held-live': {
    what: 'The workspace lock is held by a live local process (counters: holderPid).',
    impact: 'New runs are refused while the holder lives.',
    blockedActions: ['Do not unlock a live holder.'],
    safeEntries: ['Wait for the holding AgentCommit process to finish.'],
    humanConfirmation: '',
  },
  'lock-unreadable': {
    what: 'The workspace lock file exists but cannot be parsed.',
    impact: 'Ownership cannot be proven; every transactional command fails closed.',
    blockedActions: ['Do not delete the lock file by hand.'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Manually inspect the lock file; removal requires human confirmation of a dead holder.',
  },
  'sessions-unreadable': {
    what: 'The persisted sessions cannot be enumerated or fail strict validation.',
    impact: 'Recovery admission fails closed; run/status/commit/rollback all refuse.',
    blockedActions: ['Do not hand-edit or delete session files.'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Inspect the state directory with human review; the failing record names the problem (locally only).',
  },
  'session-running-pid-dead': {
    what: 'A session is marked running but its wrapper process is dead (proved by the local lock holder check).',
    impact: 'No Post exists; the pre-snapshot and journal own the transaction. New runs are refused.',
    blockedActions: ['Do not fabricate a Post or mark the session finished.', 'Do not delete the session or the lock to "unblock".'],
    safeEntries: ['agentcommit unlock --session <session-id> (interactive; proves pid death + host match, releases only the lock; it does not end the session and does not restore new-run admission)'],
    humanConfirmation: 'Confirm the agent and all its children actually stopped before unlocking — that confirmation is a precondition of unlock, never a consequence of it. Unlock releases only the lock and does not end the session: the Session stays running and still blocks new runs (sessionAdmission keeps refusing). How a crashed-run session is dispositioned is a pending independent product decision; do not bypass it by deleting records or marking the session failed by hand.',
  },
  'session-running-live-or-unproven': {
    what: 'A session is marked running and its holder cannot be proven dead locally.',
    impact: 'The session may genuinely still be running; new runs are refused.',
    blockedActions: ['Do not unlock while the holder may be alive.'],
    safeEntries: ['Wait for the wrapper to finish or verify the holder process.'],
    humanConfirmation: 'Confirm whether the wrapper process is still alive on this host.',
  },
  'session-unfinished-setup': {
    what: 'A session is in an unfinished setup state (created without a finished pre-scan, or pre-snapshot only).',
    impact: 'The session owns the workspace transaction.',
    blockedActions: ['Do not hand-edit session state.'],
    safeEntries: ['agentcommit unlock --session <session-id> (interactive, requires proof the holder pid is dead and local)'],
    humanConfirmation: '',
  },
  'session-review-pending': {
    what: 'A session finished and waits for review.',
    impact: 'The workspace keeps its lock against new runs until the session is committed or rolled back.',
    blockedActions: [],
    safeEntries: ['agentcommit status', 'agentcommit diff', 'agentcommit commit', 'agentcommit rollback'],
    humanConfirmation: '',
  },
  'session-rollback-failed': {
    what: 'A rollback failed mid-way; its restore plan and journal are retained.',
    impact: 'The session must not be marked rolled back; retry is resumable and idempotent.',
    blockedActions: ['Do not mark the session rolled back by hand.'],
    safeEntries: ['agentcommit rollback (resumes pending actions, skips verified ones)'],
    humanConfirmation: '',
  },
  'session-abandoned': {
    what: 'A session was explicitly abandoned via resolve --abandon (tracking terminated; evidence preserved).',
    impact: 'It is terminal: not a commit, not a rollback; its outcome was never measured. While it is the newest session, restore refuses rather than silently selecting an older one.',
    blockedActions: [],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: '',
  },
  'cas-check-partial': {
    what: 'The CAS existence check was bounded and did not cover every protected manifest record (counters: checked, total, unchecked).',
    impact: 'The unchecked range is unknown — not healthy; no full-storage health claim is made from a partial scan.',
    blockedActions: [],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'For a complete pass on very large manifests, run doctor on a machine/scope where the full range can be checked.',
  },
  'state-anomaly': {
    what: 'Recovery admission reports an unreadable or unknown state record.',
    impact: 'Fail-closed: no new transaction may start until a human resolves the record.',
    blockedActions: ['Do not delete the record.'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Inspect the named record locally; removal or repair needs an explicit, authorized product decision.',
  },
  'manifest-anomaly': {
    what: 'The latest session manifest cannot be loaded or fails binding validation.',
    impact: 'Diff/restore planning for that session refuses; admission may fail closed.',
    blockedActions: ['Do not hand-edit manifests.'],
    safeEntries: ['agentcommit doctor (this diagnosis)'],
    humanConfirmation: 'Inspect the manifest with human review locally; repair is not automated.',
  },
  'protection-gaps': {
    what: 'The latest manifest records protection gaps (counters: unprotectedPaths, ignoredEntries, unreadableEntries).',
    impact: 'Those paths are not protected: rollback cannot restore them, and "fully reversible" never holds while they exist.',
    blockedActions: [],
    safeEntries: ['agentcommit run prints the full Protection Summary with per-path reasons before every session.'],
    humanConfirmation: '',
  },
  'platform-win32-notes': {
    what: 'Windows (static capability notes): POSIX rwx-bit restore is not verified here (no ACL promise); creating file/dir symlinks needs Developer Mode or admin privilege (junctions work unprivileged).',
    impact: 'Verification boundary: rwx-bit restore and symlink capability are bounded by the platform this diagnosis actually ran on. Cross-platform behavior is verified by GitHub-hosted CI on Windows/Linux/macOS (Node 22/24); local manual development has been primarily Windows, so Linux/macOS are not widely verified on user machines.',
    blockedActions: [],
    safeEntries: [],
    humanConfirmation: '',
  },
  'platform-posix-notes': {
    what: 'POSIX platform (static capability notes): rwx-bit restore and symlink scanning branches are implemented for POSIX.',
    impact: 'Verification boundary: these are capability statements only — they are bounded by the platform this diagnosis actually ran on. Cross-platform behavior is verified by GitHub-hosted CI on Windows/Linux/macOS (Node 22/24); wide verification on user machines is not claimed.',
    blockedActions: [],
    safeEntries: [],
    humanConfirmation: '',
  },
}

const SAFE_SEVERITIES: ReadonlySet<string> = new Set(['info', 'attention', 'blocked'])
const SAFE_OVERALL: ReadonlySet<string> = new Set(['ok', 'attention', 'blocked'])
const SAFE_SESSION_STATUSES: ReadonlySet<string> = new Set(Object.values(SessionStatus))
const SAFE_JOURNAL_STATUSES: ReadonlySet<string> = new Set(['prepared', 'executing', 'partial', 'completed', 'corrupt'])

function safeCounters(counters: Record<string, number> | undefined): Record<string, number> | undefined {
  if (counters === undefined) return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(counters)) {
    if (Number.isFinite(value)) out[key] = value
  }
  return out
}

/**
 * Project one local finding into its share-safe form: only the stable code, a
 * validated severity, fixed per-code text, numeric counters, and an anonymous
 * session reference. Unknown codes never pass through — they become a fixed
 * `unknown-finding` with no detail, failing closed on severity.
 */
function projectFinding(findingIn: DoctorFinding, anonymousBySessionId: Map<string, string>): Record<string, unknown> {
  const severity = SAFE_SEVERITIES.has(findingIn.severity) ? findingIn.severity : 'blocked'
  const text = SAFE_FINDING_TEXT[findingIn.code]
  if (text === undefined) {
    return {
      code: 'unknown-finding',
      severity,
      what: 'An unrecognized finding was recorded; its details are withheld from the shared report.',
      impact: 'Run `agentcommit doctor` locally and inspect the local diagnosis output on this machine.',
      blockedActions: ['Treat the state as unverified until the local diagnosis is reviewed.'],
      safeEntries: ['agentcommit doctor (local diagnosis)'],
      humanConfirmation: 'Review the local diagnosis output before sharing this report or acting on it.',
    }
  }
  const projected: Record<string, unknown> = { code: findingIn.code, severity, ...text }
  const anonymous = findingIn.sessionId !== undefined ? anonymousBySessionId.get(findingIn.sessionId) : undefined
  if (anonymous !== undefined) projected.session = anonymous
  const counters = safeCounters(findingIn.counters)
  if (counters !== undefined) projected.counters = counters
  return projected
}

function projectJournal(journal: DoctorResult['sessions'][number]['journal']): DoctorResult['sessions'][number]['journal'] {
  if (journal === undefined) return undefined
  return {
    status: SAFE_JOURNAL_STATUSES.has(journal.status) ? journal.status : 'unknown',
    attempts: Number.isFinite(journal.attempts) ? journal.attempts : 0,
    receipts: Number.isFinite(journal.receipts) ? journal.receipts : 0,
  }
}

/**
 * Build a shareable report: whitelisted fields only, paths anonymized by role
 * numbering, diagnosis findings reduced to stable codes + fixed descriptions +
 * numeric counters + anonymous session references. No free text, raw error
 * messages, paths, ids, or blocker strings from persisted records are passed
 * through; the local CLI output keeps the full diagnosis.
 */
export function buildReport(result: DoctorResult): Record<string, unknown> {
  const anonymousBySessionId = new Map<string, string>()
  result.sessions.forEach((s, i) => anonymousBySessionId.set(s.id, `session-${String(i + 1).padStart(4, '0')}`))
  return {
    reportSchema: 'agentcommit.doctor-report.v1',
    generatedAt: new Date().toISOString(),
    environment: { node: result.node, platform: result.platform, arch: result.arch },
    paths: { workspace: 'workspace-1', stateRoot: 'state-root-1' },
    lock: result.lock.state === 'readable'
      ? { state: result.lock.state, pidAlive: result.lock.pidAlive, sameHost: result.lock.sameHost }
      : { state: result.lock.state },
    admission: { eligible: result.admission.eligible, blockerCount: result.admission.blockers.length },
    sessions: result.sessions.map((s, i) => ({
      anonymousId: `session-${String(i + 1).padStart(4, '0')}`,
      status: SAFE_SESSION_STATUSES.has(s.status) ? s.status : 'unknown',
      startedAt: typeof s.startedAt === 'string' ? s.startedAt : '',
      journal: projectJournal(s.journal),
    })),
    diagnosis: {
      overall: SAFE_OVERALL.has(result.diagnosis.overall) ? result.diagnosis.overall : 'blocked',
      findings: result.diagnosis.findings.map(f => projectFinding(f, anonymousBySessionId)),
    },
    boundaries: result.boundaries,
    privacy: {
      included: ['versions', 'platform', 'schema', 'statuses', 'counts', 'finding codes and severities', 'fixed per-code finding descriptions', 'numeric counters', 'anonymous session references', 'timings'],
      excluded: ['file contents', 'prompts', 'transcripts', 'config bodies', 'credentials', 'environment dumps', 'CAS contents', 'absolute paths', 'business-identifiable file names', 'hostname', 'raw session ids', 'raw diagnosis free text', 'raw error messages', 'admission blocker strings'],
      pathAnonymization: 'roles are numbered (workspace-1, state-root-1, session-NNNN); not merely username-stripping',
      findingPolicy: 'shared findings carry only their stable code, severity, fixed per-code description, numeric counters, and anonymous session reference; unknown codes are reported as unknown-finding without any detail; full diagnosis text stays in the local CLI output',
    },
  }
}
