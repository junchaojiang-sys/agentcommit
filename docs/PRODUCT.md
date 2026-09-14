# PRODUCT.md — Product Definition (V0.1)

> Source of truth: `docs/plan/AgentCommit_ZCode_实施计划书_含DeepSeek支持.pdf` (V0.1 planning v1.0, 2026-09-05),
> plus the Phase 0 review rectification (2026-09-05).
> This document freezes the product boundary for V0.1. Nothing here may change without an ADR.

## 1. One-liner

**Git for AI agents**: turn every agent execution into a reviewable Session.
The user previews the diff, chooses **Commit** to accept the changes or **Rollback** to
restore the workspace. Anything that cannot be reliably restored is labeled as such —
AgentCommit never pretends an irreversible action is undoable.

**Tagline:** Transactional safety for AI agents. Preview, commit, and safely roll back
agent changes.

## 2. What AgentCommit is

A transactional execution layer between AI agents and the local machine:

```
Codex / Claude Code / Z Code / DeepSeek / <any CLI agent>
                     │
               AgentCommit  (transaction layer)
             ┌──────────────┴──────────────┐
        Workspace (files/Git)         Tools (MCP/API — V0.3+)
        Snapshot · Diff · Restore     Risk class · Approval · Compensation
             └──────────────┬──────────────┘
                       Review session
        "18 files changed · reversible / compensable / irreversible"
                [Diff]  [Commit]  [Rollback]
```

Product rules that are non-negotiable and shape every design decision:

1. **Rollback is deterministic.** Restore paths are registered by the system before
   they are needed. The LLM never decides how to restore; it only produces actions.
2. **Compensation is not undo.** Reversing a side effect through an API (V0.3+) is a
   weaker guarantee than restoring a snapshot. The data model and the UI keep the two
   explicitly separate.

## 3. Safety boundaries (frozen at the Phase 0 review)

- **Git boundary.** *"V0.1 restores workspace file content only. It does not rewind
  Git history, index state, refs, commits, pushes, or external-world actions."* An
  agent's `git add/commit/branch/reset/push` is not rewound by rollback.
- **`agentcommit commit` ≠ `git commit`.** It means only "accept / finalize this
  AgentCommit session". It never stages, never creates a Git commit, never changes
  branches. Required output: `AgentCommit transaction accepted. / This did NOT create
  a Git commit.` (docs/CLI.md).
- **One active session per workspace.** A workspace lock fails closed on a second
  concurrent `run`; stale locks have a deterministic test; `agentcommit unlock` is an
  explicit, id-confirmed human action. Concurrent multi-agent transactions are a
  possible future feature, not V0.1 (TRANSACTION_MODEL §3).
- **Session window is attribution-free.** V0.1 captures the workspace state delta
  during the active session window and performs no writer/process attribution:
  changes from the agent, its child processes, the user, or external processes are all
  part of the session's transaction. **Do not hand-edit the workspace while a session
  is active.** Process-level attribution and realtime provenance are not V0.1.
- **Git-ignore ≠ unprotected.** Git ignores files for version-control reasons;
  AgentCommit protects files for data-safety reasons. `.env`, local databases, private
  configs, and data files are typically Git-ignored and are exactly what agents break —
  they stay protected by default (OQ-04, decided). Exclusions come only from built-in
  defaults + `.agentcommitignore` (gitignore-style patterns, OQ-12); `.gitignore` is
  never inherited (OQ-03, decided).
- **No silent unprotected paths.** Everything not protectable (oversized, ignored,
  unsupported, inaccessible, symlink-policy-rejected) appears in the Protection
  Summary before the agent runs and is re-listed at every review (TRANSACTION_MODEL
  §4).
- **Local plaintext CAS.** Protected content — including secret files, which are
  protected by default (OQ-04, decided) — is stored locally only, in plaintext. No
  telemetry, no uploads, encryption at rest not supported in V0.1, `gc`/`purge`
  present only as reserved, disabled command stubs (STORAGE §10, SECURITY §2).

## 4. V0.1 scope

### 4.1 In scope

- Wrap any local command: `agentcommit run -- <agent command>` (one session per
  workspace at a time).
- Pre-run workspace snapshot; post-run scan; created/modified/deleted classification.
- Text diff for text files; hash/size metadata for binary files.
- Whole-session rollback (journal-resumable) and single-path restore, both
  conflict-checked.
- Works in Git and non-Git projects; Git is an optional integration, never a dependency.
- Local-only: no telemetry, no uploads, no account.
- First-class Windows (NTFS, file locks, Unicode paths, long paths, junctions), plus
  macOS and Linux.

### 4.2 Explicitly out of scope for V0.1

- **External-world undo** (email, payments, deployments, messages) and **Git state
  rewind** (see §3).
- **Per-command interception.** V0.1 does not intercept each shell command the agent
  runs; it guarantees filesystem-level transaction safety around the whole run.
- Concurrent sessions in one workspace (see §3).
- GUI, desktop tray, VS Code extension. CLI reliability comes first.
- A permission policy language (`allow/ask/deny`) — planned for V0.2, after the Alpha
  Stabilization Gate (ROADMAP §5).
- 100% capture of all operating-system changes. Actions outside the boundary must be
  documented, never silently assumed.

## 5. Target users

1. Developers who use Codex / Claude Code / Z Code / DeepSeek to modify local projects.
2. Advanced users who want to raise agent autonomy without fearing accidental deletes,
   bad edits, or cross-session overwrites.
3. OSS maintainers and small teams who need teammates to run AI agents safely.
4. Windows users who should not need WSL or a workflow change to get transaction safety.

## 6. Core user stories (V0.1 contract)

| # | Story | Expected behavior | V0.1 |
| --- | --- | --- | --- |
| 1 | Agent changed 18 files — what exactly changed? | One command shows the session summary and a text diff. | Supported |
| 2 | Agent broke the project — restore to before the run. | Safe restore, only if current files still equal the session's post state. | Supported |
| 3 | After the agent finished, I also edited a file by hand. | Rollback must not overwrite my newer edits; it reports a conflict. | Supported |
| 4 | Rollback was interrupted at file 47 of 100 (crash / Ctrl+C). | Re-running `rollback` resumes from the journal, skipping verified files. | Supported (design frozen; built in P2) |
| 5 | Two agents started at once in the same project. | The second `run` fails closed with a clear lock message. | Supported (design frozen; built in P3) |
| 6 | Agent sent a wrong email. | File rollback cannot un-send email. | Explicitly not supported; addressed by the V0.3+ transaction layer |

## 7. Support matrix (V0.1)

| Agent | Integration | Notes |
| --- | --- | --- |
| Codex | `agentcommit run -- codex ...` | Wrapped as a generic process; no reliance on internals. |
| Claude Code | `agentcommit run -- claude ...` | No agent-specific filesystem hook required. |
| Z Code | `agentcommit run -- <zcode-command>` | Command name is user-configurable, never hardcoded. |
| DeepSeek | Dedicated adapter + generic fallback | First-class in V0.1, but not bound to one specific DeepSeek client. Supports DeepSeek CLI / harness / custom launchers via configurable command spec. |
| Generic CLI | `agentcommit run -- <command>` | The compatibility floor: every local command can be wrapped. |

**DeepSeek principle (reaffirmed at the review).** DeepSeek is first-class from V0.1
but never forms a second transaction core. It shares the **same** snapshot, CAS,
manifest, session, diff, conflict, and rollback machinery as every other agent. The
dedicated adapter may only handle: command detection, process naming, version
detection, optional metadata, and the user-configurable executable. A future DeepSeek
client rename cannot break the core.

Adapters are registered with:

```sh
agentcommit agent add deepseek --command "deepseek"
agentcommit agent add zcode --command "zcode"
agentcommit agent add deepseek-local --command "python -m deepseek_harness"
agentcommit run --agent deepseek-local
```

## 8. Differentiation

- **Session/Transaction is the first-class object**; snapshots are only an
  implementation mechanism. MCP tools and external actions slot into the same model
  later (V0.3+) without redesign.
- **Cross-agent.** One CLI and one storage model protect Codex, Claude Code, Z Code,
  DeepSeek, and anything else — no vendor lock-in.
- **Windows-first.** NTFS, file locks, Chinese/Unicode paths, long paths, junctions and
  reparse points, and signal interruption are tested from day one — and Windows carries
  a significant share of the release-gate dogfood sessions.
- **Safe-restore bias.** Uncertain states stop and report instead of auto-forcing a
  restore; rollback is journal-resumable after any interruption.
- **Local-first.** No cloud account; repository contents never leave the machine.

## 9. V0.1 success criteria

1. A first-time user can install on Windows/macOS/Linux and complete their first
   rollback without reading the source.
2. Rollback never overwrites user edits made after a session ends (conflict path is the
   default, tested path).
3. Unprotected files are visibly flagged before and after every run; the UI never
   claims "fully reversible" while anything is unprotected.
4. Rollback survives interruption and resumes deterministically; success is declared
   only on verified evidence.
5. A second concurrent session in the same workspace fails closed.
6. CI is green on all three platforms, including core restore/conflict integration
   tests, before any public release.

## 10. Open questions

All unresolved product decisions live in [docs/OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)
with options, security implications, and recommended defaults — and wait for explicit
user approval. The implementer never decides product boundaries.
