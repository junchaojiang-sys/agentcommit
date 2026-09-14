# STORAGE.md — Snapshot, CAS, and Local Storage (V0.1)

> Source of truth: plan PDF §7, the Phase 0 review rectification (2026-09-05), and the
> approved P2B decisions (2026-09-08).
> Status (2026-09-12): P0–P4 are complete and user-approved; P5 is release
> preparation. The durability and hardening items flagged below remain as scoped
> future work; nothing in this document is reopened.
> Storage makes no business decisions; it persists and atomically writes, nothing more
> (ARCHITECTURE.md §4).

## 1. Why pre/post manifests + CAS

V0.1 does not monitor each internal agent action. Instead:

1. Before the agent runs, scan the workspace and ensure all protectable file content is
   in the content-addressable store (CAS).
2. After the agent exits, scan again.
3. Diff the two manifests to produce the change set.

This captures the **workspace state delta during the active session window** —
whatever process produced the change (agent, child process, user, external tool) —
while staying independent of any agent's tool-call protocol. V0.1 performs no writer
attribution (TRANSACTION_MODEL §1).

## 2. On-disk layout

```
Windows:   %LOCALAPPDATA%\AgentCommit\
Unix:      ~/.agentcommit/
  blobs/
    sha256/ab/cdef...                       # content stored once, addressed by SHA-256
  workspaces/<workspaceId>/
    sessions/<sessionId>.json               # session metadata
    sessions/<sessionId>.journal.json       # Restore Journal (TRANSACTION_MODEL §9)
    journal-history/<sessionId>/<planId>.json # archived scoped Journal source
    manifests/<manifestId>.json
  locks/
    <workspaceId>.lock                      # workspace lock (TRANSACTION_MODEL §3)
  logs/                                     # paths/hashes/status only — never contents
```

Project-local files (inside the user's repository):

```
.agentcommit.json        # workspace id + agent registry + limits
.agentcommitignore       # user-defined exclusions (optional)
```

- Blobs are deduplicated by content: identical bytes are stored exactly once across all
  workspaces and sessions. Session metadata stores only relative paths, hashes, sizes,
  and types — never a copy of the project tree.
- **Journal writes are part of the atomic-write protocol**: one immutable plan header is
  persisted before the first restore action, bound to the workspace root,
  workspace/session ids, Pre/Post manifests, frozen policy, plan digest, and requested
  scope. For each action, `intent` is persisted before the action; only after the
  restore target and supported metadata verify does `verified` get persisted
  (temp → fsync → rename). A failed action remains partial/retryable and retains its
  Journal.
- A process kill may leave a restore temporary file. Its Journal entry binds the temp
  path to the exact attempt and action; retry never deletes an old temp whose current
  ownership cannot be proven, and uses only the new attempt's owned temp. Per-attempt
  and per-action Journal records do not claim that the whole selected path set was
  restored after termination.
- Whole-session restore, single-path restore, and retry all use the same executor and
  Journal schema. A single-path result records its scope and verified path; it does not
  finalize the whole Session. On retry, every previously `verified` path is re-observed
  against its restore target before it can be considered satisfied. A mismatch is a
  conflict, including Current returning to Post after a prior verification; the Journal
  marker alone never suffices.
- Restore admission considers only the current workspace's latest unfinalized,
  recoverable Session. If it is unavailable or cannot be recovered, the command
  rejects the request and never falls back to historical sessions. A pending partial
  Journal blocks new Pre/Post scans and cannot be bypassed by labeling the Session
  ordinary `failed`.
- The P2B core boundary is `prepareRestore` (immutable plan/Journaling with no target
  writes), `executeRestore` (the shared whole/single-path/retry executor), and
  `loadRestoreJournal` (integrity and binding validation). Unknown or corrupt latest
  Session/Journal state, an ambiguous latest timestamp, an unfinished older Journal,
  or a plan that is not for the latest Session is rejected.
- A completed single-path Journal is archived at
  `journal-history/<sessionId>/<planId>.json`. A later whole-session Journal carries
  receipts that reference the source `planId`, `planDigest`, `attemptId`, action path,
  and expected fingerprint; receipt archive and source action bindings are rechecked
  before a receipt is accepted.
- **Lock files are created exclusively** (atomic create-or-fail) and deleted only by
  the deterministic stale-lock rules or the confirmed `agentcommit unlock`.

## 3. Atomic write protocol

Every metadata write follows **temp file → fsync → atomic rename**. A process crash must
never leave behind a session, manifest, or journal that looks complete but is
half-written. P2B's recovery evidence covers process termination; it makes no claim of
whole-machine restart or power-loss durability.
CAS blob writes follow the same protocol, and a blob whose re-hash does not match its
address is treated as corrupt (§6) — never served silently. POSIX parent-directory
fsync after rename (power-loss durability) is a **known v0.1 limitation / future
hardening** item; no native dependency will be introduced for it in V0.1.

## 4. Ignore policy — Git ignore and AgentCommit protection are different concepts

**`.gitignore` is NOT treated as an AgentCommit exclusion.** Git ignores files for
version-control reasons; AgentCommit excludes files for protection-cost reasons. The
typical `.env`, local database, private config, or data file is Git-ignored yet is
exactly what an agent can destroy — if it were excluded from snapshots, rollback could
not restore it. That is unacceptable, so:

- The **only** exclusion sources are the built-in defaults below plus
  `.agentcommitignore`; `.gitignore` is **never inherited** (OQ-03, decided
  2026-09-05). It may be read for performance hints in warnings only — never as an
  exclusion source.
- Default exclusions target high-cost/irrelevant directories only:

```
.git/**
.agentcommit/**
node_modules/**
dist/**
build/**
.next/**
coverage/**
.venv/**
venv/**
__pycache__/**
target/**
*.tmp
*.cache
```

- `.agentcommitignore` uses **gitignore-style pattern semantics** (OQ-12, decided
  2026-09-05). The matcher implementation is an engineering decision (IQ-03): prefer a
  mature, battle-tested implementation; if the full documented gitignore semantics
  cannot be met, the supported subset must be explicitly documented and covered by
  compatibility tests — full compatibility must never be claimed falsely.
  Negation subset (tested): `X/**` + `!X/child` re-includes the child; a directory
  exclusion `X/` prunes X and its children cannot be re-included (git-identical).
- **Frozen policy (Blocker 1):** the effective ignore rules, cap, and their versions
  are captured as an immutable `ProtectionPolicySnapshot` in every pre-manifest.
  Post scans (Phase 2) reuse the frozen policy — a mid-session mutation of
  `.agentcommitignore` can never change the Pre/Post scan universe.
- Excluded paths are not recorded as FileRecords, but every ignored boundary (subtree
  root or single file, with matched rule and source) is disclosed in the Protection
  Summary (TRANSACTION_MODEL §4) — exclusions are never silent, and pruned
  descendants are never enumerated wholesale.

## 5. Large file policy — no silent skipping

- Default per-file protection cap: **100 MB**. Per-project override via
  `.agentcommit.json` (`maxFileSizeBytes`) is allowed and the effective cap is always
  shown in the Protection Summary (OQ-06, decided 2026-09-05). Raising the cap extends
  protection (files become protected, never excluded); lowering it increases the
  number of unprotected files; raising it mainly costs snapshot time, disk usage, and
  resource pressure.
- Any path that is not protected — **oversized, ignored, unsupported, permission-
  denied/inaccessible, symlink-policy-rejected, special file, or policy-excluded** — is
  surfaced, never silently skipped:
  - unprotected FileRecords carry their `reasonUnprotected` and are listed individually
    in the Protection Summary before the agent starts;
  - ignored paths are disclosed as **ignored boundaries** — subtree roots (or single
    files) with matched rule and rule source — and additionally counted; a count alone
    is never the whole disclosure (TRANSACTION_MODEL §4);
  - `diff`, `status`, and `rollback` re-list every unrecoverable path at review time.
- The product must never give the impression that "everything can be rolled back" while
  unprotected paths exist.

## 6. CAS integrity

A blob is trusted only if its bytes re-hash to its address. Missing or corrupt blobs
are reported (`BLOB_MISSING` / `BLOB_CORRUPT`), block the affected rollback before any
file is touched, and mark the involved paths `unrecoverable` — never a silent skip, and
never a rollback declared successful with a missing blob (TRANSACTION_MODEL §10).

**Existing blobs are not trusted merely because their pathname matches the expected
hash.** Before any dedupe success, the existing blob's bytes MUST be re-hashed and
compared to the expected address; on mismatch the operation fails closed with
`BLOB_CORRUPT` and the pre-snapshot does not produce a trusted baseline. (Automatic
repair of corrupt blobs is out of scope for V0.1.)

**Stable read (TOCTOU rule):** a regular file is snapshotted as
`metadata A → open/read/hash/write temp CAS content → metadata B → compare`.
A and B must match on size and mtimeNs, plus inode/device identity where the
platform exposes it. Mismatch ⇒ the snapshot is retried (≤ 2×, re-observing fresh
metadata); a persistently changing file fails closed with
`FILE_CHANGED_DURING_SNAPSHOT`. An unstable read never yields a successful manifest
baseline, never marks the file `protected`, and leaves no orphan CAS temp files.

## 7. Sensitive data in the CAS

Because secret-looking files (`.env`, credentials, private configs, token caches,
local databases) are **protected by default** (OQ-04, decided 2026-09-05), the CAS
holds **plaintext copies of whatever the workspace contained**. Consequences, all
normative:

1. V0.1 is **local-only**: no snapshot, blob, hash, or path ever leaves the machine.
2. Uploading snapshots/blobs is prohibited by design; there is no network client.
3. No telemetry.
4. Logs record paths, hashes, statuses, and errors — **never file contents, never
   secret values**.
5. The storage root is restricted to the current user (`0700`/`0600` on Unix where
   supported; user-profile ACLs on Windows, restrictive inherits applied where
   feasible).
6. **No automatic cleanup in V0.1 alpha.** V0.1 alpha never automatically deletes
   Sessions, Manifests, or CAS blobs; retention is keep-all (OQ-11). `agentcommit gc`
   and `agentcommit purge` exist only as reserved CLI surface stubs — invoking them
   performs **no** cleanup and deletes **nothing** (see §10). They must not be relied
   on as a current privacy mitigation; a global safe cleanup path requires separate
   future authorization and implementation.
7. The risk is disclosed, not hidden: README and SECURITY.md state that secret files
   are duplicated into the local store.
8. **AgentCommit never implies the CAS is an encrypted vault. Encryption at rest:
   NOT SUPPORTED IN V0.1.** It is a stated hardening item for a later version, not a
   hidden feature or a marketing claim.

## 8. Symlinks and junctions

- Symlinks: record the link target only; never follow.
- Mode restoration applies only to the regular-file object. The executor never follows
  a symlink to run `chmod`; the supported Unix `rwx` bits (`mode & 0o777`) are restored
  and verified, and any supported failure is an error. Special mode bits, ownership,
  xattrs, ADS, and `mtime` are not restored; Windows ACL restoration is not promised.
- On Windows, ordinary regular-file content replacement is supported, and deleting a
  created junction removes only the junction entry itself. Recreating a junction or
  symlink is explicitly `blocked`; the external target is never followed or modified.
- Missing parent directories, parent links/junctions, directory targets, and unknown or
  dangerous entry types are `blocked`; restore never auto-creates directories or uses
  recursive removal to make an action fit.
- **Known symlinks and junctions are never followed** (recorded, never recursed into —
  this prevents scanning outside the workspace). Unknown / non-symlink Windows reparse
  points are not yet reliably detected; **this is a known v0.1 limitation / future
  hardening** (see
  SECURITY.md §4). No stronger claim is made until code + Windows tests prove complete
  reparse handling. A link whose policy
  makes it unrestorable is recorded with `symlink-policy-rejected` and appears in the
  Protection Summary.

## 9. Workspace identity and discovery

`agentcommit init` creates a `workspaceId` (UUID) stored in `.agentcommit.json`,
mapping the project directory to its sessions/manifests/lock in the state directory.

**Discovery (frozen):** every AgentCommit command other than `init` resolves the
workspace by walking up from the current working directory through parent directories
to the **nearest `.agentcommit.json`**; the directory containing that file is the
workspace root. An inner config shadows an outer one, so nested workspaces resolve
deterministically to the nearest identity. If the search reaches the filesystem root
without a match, the command **fails closed** with the stable error
`WORKSPACE_NOT_INITIALIZED` and a hint to run `agentcommit init`. AgentCommit never
auto-initializes a workspace.

## 10. Garbage collection — CURRENT STATUS

**`agentcommit gc` and `agentcommit purge` are reserved but disabled in 0.1 alpha.**
Both exist only as CLI surface stubs: invoking either returns a stable
`NOT_IMPLEMENTED` refusal, deletes nothing, and writes no state. V0.1 alpha has
**no automatic pruning** (retention is keep-all, OQ-11) and no automatic cleanup of
Sessions, Manifests, or CAS blobs.

The planned future semantics — `gc` collecting blobs unreferenced by any session and
sessions past a retention policy, and `purge` removing all AgentCommit state for the
current user after typed confirmation — are design intent only. Implementing them
requires separate future authorization; until then they are neither available nor a
privacy mitigation. Both commands are local operations only by design.
