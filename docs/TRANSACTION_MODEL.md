# TRANSACTION_MODEL.md — Session, Changes, and Conflict Safety (V0.1)

> Source of truth: plan PDF §6 (data model), §8 (diff/rollback/conflict), plus the
> Phase 0 review rectification (2026-09-05), P1 final rectification/closeout, and the
> approved P2B decisions (2026-09-08).
> Status (2026-09-12): P0–P4 are complete and user-approved; P5 is release
> preparation. The durability and hardening items flagged below remain as scoped
> future work; nothing in this document is reopened.
> The three-version rule in §5 is the safety core of the product. Any change here is a
> product decision, not an implementation detail, and requires explicit user approval.

## 1. Session

A **Session** is the transaction: one agent execution inside one workspace.

```ts
interface Session {
  id: string
  workspaceId: string
  agent: { kind: string; command: string; version?: string }
  startedAt: string            // ISO-8601 UTC
  endedAt?: string
  status: SessionStatus
  preManifestRef?: string      // manifest id
  postManifestRef?: string
  changes: Change[]
  conflicts: Conflict[]
  verification?: { exitCode: number | null; checks: string[] }
}
```

**Transaction window.** A session's transaction window runs from the pre-scan to the
post-scan. Every workspace file change inside the window — from the agent, its child
processes, the user, or any external/background process — is a change of this
session: **V0.1 performs no writer/process attribution.** Users must not hand-edit
the workspace while a session is active; process-level attribution and realtime
provenance are future work, not V0.1.

### 1.1 State machine

```
            create session (requires exclusive workspace lock)
                 |
               ready ----------------> failed   (fatal setup error: no snapshot possible)
                 | pre-scan + CAS complete + Protection Summary accepted
               snapshot
                 | agent process spawned
               running ---- Ctrl+C / signal ---> review | failed
                 | agent exited (any exit code) -> post-scan complete
               review -----> committed
                 |             +--------> rolled_back
                 +-- rollback attempted & failed
                      +-> rollback_failed   (journal retained; retry resumes it)
```

Rules:

- Every state transition is persisted **before** work continues (atomic metadata
  writes). A crash must never leave a state that looks complete but is half-written.
- A session in `review` always has: post manifest, change set, and the unprotected-path
  list if any (§4).
- `committed` means "user accepted these changes". It is **not** a Git commit — it never
  stages, commits, or alters any Git state (docs/CLI.md).
- `rolled_back` is written only after **all six success conditions in §10** hold.
- `rollback_failed` sessions keep their Restore Journal; re-running `agentcommit
  rollback` resumes from the journal.
- A partial or retryable restore with a pending Journal remains a recovery-pending
  session. It cannot be relabeled as ordinary `failed`, and ordinary `failed` admission
  cannot bypass the pending Journal or workspace lock. New Pre/Post scans are refused
  until that Journal reaches a verified terminal outcome.
- The workspace lock (§3) is held from session creation until the session reaches a
  terminal state (`committed`, `rolled_back`, or `failed`). `rollback_failed` is not
  terminal: the lock stays held so no other session can start on a half-restored
  workspace; the retry path reuses it.

Restore admission is limited to the current workspace's latest session that is both
unfinalized and recoverable. If that session is missing, corrupt, finalized, or cannot
be safely recovered, the command rejects the request and never selects an older session.

### 1.2 P2B implementation boundary

- `prepareRestore` selects the latest recoverable Session. When it builds a new
  immutable, root-bound plan and Journal it takes the workspace lock and performs no
  workspace target writes. An unfinished Journal is reused only with the same root and
  scope, while an unknown, corrupt, tied, or otherwise unsafe latest-session state is
  rejected.
- `executeRestore` is the single whole-session, single-path, and retry executor. It
  reloads and validates the latest Session, plan, manifests, Journal, parent
  dependencies, Current state, and CAS before any target action.
- `loadRestoreJournal` accepts only an integrity-checked Journal for the requested
  workspace/session. Unknown Journal shapes, bindings, digests, attempts/actions, or
  receipt archives are rejected; no historical Journal is selected as a fallback.

## 2. FileRecord — frozen minimal metadata contract

V0.1 records and restores **the minimal cross-platform set**. The contract below is
frozen; `packages/core` type constants are aligned with it at Phase 1 entry.

```ts
interface FileRecord {
  path: string               // workspace-relative, normalized (forward slashes)
  type: 'file' | 'symlink' | 'junction' | 'reparse' | 'unsupported'
  hash?: string              // SHA-256 hex of content (regular files)
  size: number
  mode?: number              // Unix regular-file rwx bits (mode & 0o777), verified (§2.1)
  mtimeNs?: string           // REFERENCE ONLY — never a restore criterion (§2.1)
  symlinkTarget?: string     // recorded, never followed
  protected: boolean         // true iff a restorable content snapshot exists
  reasonUnprotected?: 'file-too-large' | 'unsupported-special-file'
                           | 'inaccessible' | 'symlink-policy-rejected'
}
```

### 2.1 What V0.1 restores — and what it explicitly does not

| Item | Restored in V0.1? |
| --- | --- |
| File content (by hash) | Yes — byte-exact, hash-verified |
| Symlink / junction target | Unix link recreation is supported without following the target; Windows junction/symlink recreation is **blocked** in V0.1 |
| Unix regular-file `rwx` permission bits (`mode & 0o777`) | Yes — restore the recorded bits and verify them; any supported failure is an error (OQ-07) |
| Special POSIX mode bits (setuid/setgid/sticky) | **No — explicitly not restored in V0.1.** |
| `mtime` | **No — reference/diagnostic only.** Recorded for correlation; never used to decide or verify a restore. Restore is content-addressed and deterministic. |
| Windows ACLs | **No. Explicitly not restored in V0.1.** |
| POSIX ownership (uid/gid) | **No. Explicitly not restored in V0.1.** |
| Extended attributes (xattrs) / alternate data streams (ADS) | **No. Explicitly not restored in V0.1.** |
| Directories as such | Not individually recorded. Missing or unsafe parent directories are **blocked**; restore never auto-creates them. Empty directories created by a session are **not** removed by rollback (documented limitation). |

The goal: the user always knows what rollback restores (content + links, plus the
supported Unix regular-file `rwx` bits) and what it does not (special bits, ownership,
xattrs, ADS, `mtime`, Windows ACLs, Git state, external world).

**Stable-read guard (P1 rectification, Blocker 2):** regular files are snapshotted
with TOCTOU validation — the file identity (size, mtime, inode, device) captured
before the streaming read must match after it. A file that mutates mid-snapshot is
retried (up to 2 times, re-observing fresh identity); a persistently changing file
fails closed with `FILE_CHANGED_DURING_SNAPSHOT` and the session records `failed`
with no trusted manifest. **Scope:** V0.1 provides no atomic workspace snapshot;
transactional consistency of a live database modified during the read is not
guaranteed; AgentCommit does not claim to eliminate every concurrent-modification or
TOCTOU risk — the guard detects and rejects the mutations it can observe
(size/mtime/identity), discards the affected read, and fails closed when instability
persists.

Paths excluded by ignore rules (defaults + `.agentcommitignore`) are **not**
FileRecords; they are disclosed as ignored boundaries and counted in the scan
statistics (§4) so the Protection Summary can show them.

## 3. Workspace lock — one active session per workspace

**Rule: at most one active AgentCommit Session may exist per workspace at any time.**
Two concurrent sessions (Terminal A: `agentcommit run -- zcode`, Terminal B:
`agentcommit run -- codex`) cannot attribute changes to the right transaction, would
pollute each other's post-manifest, and could make rollback restore the other agent's
edits. V0.1 therefore does not implement concurrent transactions.

1. `agentcommit run` first resolves the workspace root and workspaceId (the canonical
   workspace identity), then creates the workspace lock **before** the pre-scan — the
   lock is always keyed to an established identity, never the other way around. The
   lock lives in the state directory
   (`locks/<workspaceId>.lock`, see STORAGE §2) and contains:
   `workspaceId`, `sessionId`, `pid`, `hostname`, `processStartedAt`, `createdAt`,
   `agentCommand`.
2. A second session detecting a valid lock must **fail closed** (`WORKSPACE_LOCKED`),
   printing who holds it (sessionId, createdAt, command). It may not silently share the
   workspace and may not automatically override the lock.
3. **Stale locks have a deterministic test:** a lock is stale iff the recorded process
   is provably gone — `pid` no longer exists, or the running process's start time
   differs from `processStartedAt` (guards against pid reuse). This is checked by
   ordinary code; **LLM judgment is never involved in lock decisions.**
4. If a lock exists and **cannot be proven stale** (e.g. hostname differs, check
   fails, or the holder looks alive), startup is **refused**. The human may run
   `agentcommit unlock --session <id>`, which requires typing the session id — an
   explicit, confirmed human action, never an automatic one.
5. Cleanup of proven-stale locks is deterministic CLI behavior (delete + log), not a
   judgment call.
6. The lock is released only when the session reaches `committed`, `rolled_back`, or
   `failed`. Crash leftovers are handled by rule 3–5 on the next attempt.

Multi-agent concurrent transactions remain a possible future feature; nothing in V0.1
pretends to support them.

## 4. Protection Summary — nothing unprotected is ever silent

Before the agent starts, `run` prints the scan result and gates on it:

```
Protection Summary
  Protected files:       18,421
  Ignored files:          7,213
  Oversized files:            3
  Unsupported files:          1

UNPROTECTED PATHS
  data/database.db       812 MB   (file-too-large)
  models/model.bin       2.1 GB   (file-too-large)
  legacy/notesMax.txt    164 MB   (unsupported-special-file)

These paths cannot be restored by this session. Continue?
```

Hard rules:

1. Every FileRecord records why it is unprotected (`reasonUnprotected`: oversized,
   unsupported special file, inaccessible/permission-denied, symlink policy rejected).
2. Ignored paths (default + `.agentcommitignore` exclusions) are counted AND disclosed
   as ignored boundaries (rule 6 below) — the user sees both how much of the tree is
   excluded and which subtree roots / rules caused it.
3. AgentCommit must never create the impression that "the whole project" is
   restorable while any scanned path is unprotected.
4. **Interactive:** the run pauses at `Continue?`.
5. **Non-interactive:** the policy (warn-and-continue vs fail-closed) is OQ-05;
   whichever is chosen, the summary is always fully printed, and `diff`/`rollback`
   re-list every unrecoverable path at review time.
6. **Ignored boundaries are disclosed, not just counted** (P1 rectification,
   Blocker 3): every ignored subtree root — or individually ignored file — is
   recorded as `IgnoredBoundary { path, kind, source, rule, reason }`. `source`
   distinguishes builtin defaults from `.agentcommitignore`; pruned descendants
   are not enumerated (no Manifest explosion). Example disclosure:
   `node_modules/ -> builtin: node_modules/**`. Negation semantics (documented
   subset): `build/**` + `!build/keep.txt` re-includes the child; a directory
   exclusion `build/` prunes the whole subtree — children cannot be re-included
   (git-identical behavior, asserted by tests, never silent).

## 5. Change taxonomy

| Change | Pre | Post | Rollback behavior |
| --- | --- | --- | --- |
| Created | absent | exists | If current == post: delete. Otherwise: **conflict**. |
| Modified | exists | exists, hash changed | If current == post: restore pre blob. Otherwise: **conflict**. |
| Deleted | exists | absent | If still absent: restore pre blob. If a new path exists there: **conflict**. |
| Metadata-only | same hash | mode/target changed | Restore and verify only the supported metadata set (§2.1); a supported rwx restore or verification failure is an error. |
| Unprotected (large/special/inaccessible) | content unknown | changed | **Never claimed recoverable.** Surfaced in the Protection Summary and at every review. |

Missing parent directories, parent links/junctions, directories at a file target, and
unknown or dangerous entry types are `blocked` during planning/preflight. They are
never repaired by automatic `mkdir`, recursive removal, or Force.

## 6. Diff output

- Text files: unified diff via a mature JS library plus AgentCommit's own formatter.
- Binary files: hash + size change only. Never a pseudo-text diff.
- `agentcommit diff [path]` scopes output to one path.

## 7. Three-version safety rule (the core — unchanged by review)

**Rollback is not "copy the old file back".** Every path compares three states:
**Pre** (before the agent ran), **Post** (after the agent exited), **Current** (right
now). `Current != Post` => **CONFLICT**. This principle is confirmed as-is.

Canonical example: Pre `file=A`, agent writes `file=B` (Post=B), user then edits to
`file=C`. Rollback must not restore A over C — the user's C would be destroyed. The
correct behavior is to report CONFLICT and stop. The same applies when the agent
deleted a file and the user recreated a file at the same path.

| Scenario | Current vs Post | Default behavior |
| --- | --- | --- |
| Agent modified, user didn't touch afterwards | equal | Safe restore of Pre |
| Agent modified, user edited afterwards | different | **CONFLICT — refuse to overwrite** |
| Agent created file, user edited it afterwards | different | **CONFLICT — refuse to delete** |
| Agent deleted file, user recreated path | different/path exists | **CONFLICT — refuse to overwrite** |
| Binary file changed | compared by hash | No text diff, but still safely restorable |

On a retry, a Journal entry marked `verified` is never accepted on its own. The
executor re-observes Current and compares it with the restore target. Any current state
that no longer matches that target is a conflict, including a user change that happens
to return the path to its Post state; the earlier `verified` marker does not authorize
an overwrite.

## 8. Force restore — stays a dangerous, deliberate act

- Default behavior is always: refuse to overwrite conflicts.
- `--force` is off by default and requires an explicit second confirmation: the CLI
  lists how many paths will be overwritten and requires typing the session id suffix.
- The resulting Force authorization is bound to the exact `sessionId`, RestorePlan
  digest, conflict path set, and observed Current state for those paths. Any Current
  change invalidates that authorization and requires a new explicit authorization.
- Force applies only to conflicts explicitly listed by the current plan that have not
  already been executed. A path with a prior `verified` action or completed receipt is
  still a conflict after any later user edit, including a change back to Post; Force
  rewriting of an already restored path is not implemented.
- Force never bypasses workspace/session identity, path containment and type safety,
  CAS or Journal integrity, no-follow-link rules, or unknown/unsupported/dangerous
  file boundaries.
- Every core/library API defaults to `force = false`. There is no global "always force"
  switch. **No UX convenience may weaken this flow.**

## 9. Restore Journal — rollback is deterministic, idempotent, retryable, resumable

Rollback must survive a process interruption: Ctrl+C at file 47 of 100, an AgentCommit
process crash, or a tested Node process kill must leave a Journal and a recoverable path
to a known workspace state. P2B makes no whole-machine restart or power-loss recovery
claim; parent-directory fsync remains a known v0.1 limitation / future hardening item.

1. Before the first restore action, the full **RestorePlan** is persisted as the
   immutable journal header (`sessions/<sessionId>.journal.json`, STORAGE §2). The
   header binds the workspace root, workspace/session ids, Pre/Post manifests, frozen
   policy, plan digest, and requested scope.
2. Before each action, an `intent` record is atomically appended. The executor then
   performs the action and verifies the restore target, including the in-scope Unix
   regular-file `rwx` bits where applicable. Only after verification passes is a
   `verified` record atomically appended; a failed action records failure and leaves the
   session partial/retryable.
3. Every action is **idempotent**: writing blob content to a path that already has the
   target hash is a no-op; deleting an already-absent path is a no-op; recreating a
   link with the same target is a no-op. A crash between "action applied" and "journal
   updated" is therefore safe to replay.
   A process kill may leave a temporary file. Its Journal record binds that temp path
   to its exact attempt and action; a retry never deletes an old temp whose current
   ownership cannot be proven, and creates/uses only its own attempt's temp.
4. Re-running the same restore executor loads the Journal and re-observes every path,
   including paths previously marked `verified`. A path may be counted as already
   satisfied only after the fresh observation matches its restore target; otherwise it
   is a conflict and is not overwritten automatically. The executor continues only
   with actions that remain safe:

```
RESTORE PLAN — 100 actions
Verified: 47   Pending: 53   Failed: 0
```

The Journal's per-attempt/action records are authoritative after process termination;
P2B does not claim that a whole selected path set was restored merely because a process
was killed or a retry was admitted.

5. Execution order: all writes (temp file -> atomic rename) first, deletions last;
   every restored file is re-hashed against the pre-recorded hash.
6. A rollback that cannot even start safely (missing/corrupt blob, unresolved
   conflict without force) touches **nothing** — the plan is validated before the
   first action.

### 9.1 One executor for whole-session, single-path, and retry

Whole-session restore, single-path restore, and retry all call the same
`executeRestore` executor and write the same Journal schema. A completed single-path
Journal is archived at
`journal-history/<sessionId>/<planId>.json`. The later whole-session Journal carries
receipts that name the source `planId`, `planDigest`, `attemptId`, action path, and
expected fingerprint; it re-observes those receipts before accepting them. Single-path
completion records its scope and verified path, but it does not set the Session to
`rolled_back`; that terminal state requires a later whole-session execution to satisfy
every condition in §10. There is no second `repair` command or separate repair
algorithm.

## 10. Rollback success conditions (all six required)

`rolled_back` may be set **only** when every one of the following holds. A rollback
that merely "finished running" is not a successful rollback.

1. Every required action of the Restore Plan completed.
2. Every restored content verified by hash.
3. Required (in-scope, §2.1) metadata verified.
4. No unresolved conflict remains.
5. No missing or corrupt blob was encountered.
6. No pending restore action remains.

If any condition fails, the CLI must not display success. The session remains
partial/retryable as `rollback_failed` with the Journal retained for retry; it may not
be admitted as an ordinary `failed` session while required actions remain unresolved.
