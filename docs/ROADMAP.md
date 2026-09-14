# ROADMAP.md — Phase Plan and Version Roadmap

> Source of truth: plan PDF §12 (phases), §14.1 (hard rules), §16 (versions), plus the
> Phase 0 review rectification (2026-09-05).
> **Each phase ends with a report and a full stop.** No phase may start without the
> previous phase being reviewed and approved by the user.

## 1. Phase overview

| Phase | Goal | Est. time | Ends with |
| --- | --- | --- | --- |
| P0 | Spec freeze + repo skeleton, **no core implementation** | 0.5–1 d | Review rectification applied |
| P1 | Workspace scan + manifest + CAS + ignore | 2–3 d | Stop & review |
| P2 | Diff + restore + 3-way conflict + journal + session state | 2–3 d | Stop & review |
| P3 | CLI + generic/codex/claude/zcode/deepseek adapters | 1–2 d | Stop & review |
| P4 | Windows/macOS/Linux QA + structured dogfood gate + CI | 1–2 d | Stop & review |
| P5 | README/demo/npm/release docs + safety statements | 0.5–1 d | Stop & review |

Budget guidance: expected case 8–11 working days, ~1.2M–1.8M effective tokens.

## 2. Phase exit criteria

> **Status (2026-09-12): P0–P4 COMPLETE and APPROVED; P5 (release preparation /
> alpha) in progress.** The per-phase criteria below are kept as the historical
> specification of what each phase had to satisfy; they are no longer "current
> phase" markers. Cross-platform CI (Windows/Linux/macOS × Node 22/24) is green
> (run 34420672968), crashed-run operator recovery shipped as `resolve --abandon`,
> and the 20/20 real-agent dogfood gate is complete (Z Code 18 + Codex 2).

### P0 — spec freeze ✅

Original criteria: six spec docs done; public API and CLI surface defined as a thin,
compiling skeleton; lint + typecheck + smoke build pass; open questions explicitly
listed; forbidden — real rollback, SQLite/native DB, GUI, permission engine, MCP.

**Review rectification additions (2026-09-05) — frozen in this phase:**

- Workspace lock semantics frozen: one active session per workspace, fail closed,
  deterministic stale detection, id-confirmed manual unlock (TRANSACTION_MODEL §3).
- Ignore semantics frozen and decided: `.gitignore` is never an exclusion source
  (OQ-03 = A); `.agentcommitignore` uses gitignore-style pattern semantics, with the
  matcher implementation left as an engineering decision and any subset documented +
  compatibility-tested (OQ-12); secret files protected by default (OQ-04 = A);
  per-project `maxFileSizeBytes` override allowed and always surfaced (OQ-06 = A).
- Git boundary frozen: file content only; the verbatim boundary sentence is normative
  (SECURITY §1).
- Unprotected-path policy frozen: Protection Summary, per-path reasons, no silent
  skipping, interactive/non-interactive gating (TRANSACTION_MODEL §4, OQ-05);
  per-project size-cap override allowed and surfaced (OQ-06 = A).
- Local secret/CAS policy frozen: local-only, no uploads, no telemetry, plaintext CAS
  disclosed, encryption at rest not supported in V0.1, gc/purge command surface
  reserved; implementation disabled in alpha (STORAGE §10);
  secret files protected by default (OQ-04 = A).
- `agentcommit commit` CLI semantics frozen: accept-session only, never Git
  (docs/CLI.md).

### P1 — snapshot/CAS

- Workspace discovery (frozen semantics: cwd parent-walk to nearest
  `.agentcommit.json`; filesystem root without a match ⇒ fail closed
  `WORKSPACE_NOT_INITIALIZED`, no auto-init), workspace UUID, default + custom
  ignore (gitignore-style `.agentcommitignore` per OQ-12; matcher implementation per
  IQ-03), manifest, SHA-256 CAS, atomic metadata writes. Pre-snapshot path works
  end-to-end with tests. **No rollback yet.**
- Damaged-blob detection, size cap (default 100 MB; per-project override decided,
  OQ-06), symlink/junction safety.
- **Review additions:** implement the frozen FileRecord metadata contract
  (TRANSACTION_MODEL §2) in code — including `reasonUnprotected`
  (oversized / unsupported / inaccessible / symlink-policy-rejected) recorded per path,
  ignored-path counts for the Protection Summary, and mtime as reference-only. Align
  `packages/core` type constants with the frozen spec (not touched during the
  doc-only rectification round).
- Workspace lock file format + atomic create per frozen semantics (lock acquisition
  wiring into `run` is P3; the format and stale rules are spec'd now, built here).

### P2 — diff/rollback/conflict

- Post manifest + change set; text diff; binary metadata diff.
- 3-way Pre/Post/Current conflict engine; whole-session rollback; single-path restore;
  restore plans; `rollback_failed` state; post-restore hash verification.
- Hard rule (unchanged): `Current != Post` ⇒ CONFLICT by default. Force requires
  explicit double confirmation. Missing blob ⇒ rollback cannot be marked successful.
- **Review additions — Restore Journal:**
  - journal persisted before the first action; per-action results persisted atomically
    (write-ahead) as they complete;
  - rollback is deterministic, **idempotent, retryable, resumable** — re-running
    `rollback` skips restored-and-verified actions and continues pending ones;
  - interrupted-rollback recovery is a tested scenario, not a hope: verified via
    deterministic sync-point + process termination (SIGKILL) + fresh-process resume,
    and real-agent Ctrl+C interruption; power-loss-grade whole-machine durability
    is explicitly out of scope;
  - success declared only when all six conditions (TRANSACTION_MODEL §10) hold.
- Integration tests: mixed created/modified/deleted, post-session user edits, recreated
  paths, binaries, mid-rollback failure **and mid-rollback resume**.

### P3 — CLI + adapters

- `init/run/status/diff/commit/rollback/restore/history` (+ `unlock`, `purge`,
  `doctor`, `gc`, `agent` group — `gc`/`purge` as disabled surface stubs) with signal
  forwarding.
- Generic wrapper stabilizes **first**; then identity adapters (Codex, Claude Code,
  Z Code, DeepSeek). Z Code/DeepSeek commands always user-configurable; adapters share
  the one transaction core and never carry protection logic.
- Mock agent executables in CI: arg passthrough, exit codes, Ctrl+C, session lifecycle.
- **Review additions:**
  - workspace lock wired into `run`: resolve workspace identity → acquire lock →
    fail closed → stale rules → confirmed `unlock`;
  - subprocess safety per ARCHITECTURE §5.3: `CommandSpec` = executable + argv,
    spawned with `shell = false`; convenience command strings safely parsed, never
    shell-evaluated;
  - Protection Summary printed and gated before every `run`
    (interactive prompt; non-interactive per OQ-05 decision);
  - `agentcommit commit` prints `AgentCommit transaction accepted. / This did NOT
    create a Git commit.` and performs no Git operation — enforced by a test that
    asserts no git subprocess is spawned.
- Dogfood begins: wrap Z Code developing AgentCommit (≥ 3 recorded sessions).

### P4 — cross-platform reliability + structured dogfood gate

- ~~**Release Blocker: crashed-run operator recovery.**~~ **DONE** — shipped as
  `resolve --abandon` (P4): a hard-killed Wrapper leaves a `running` Session and
  new runs safely refuse; after the user confirms the Agent/child has stopped,
  the deterministic safe workflow restores workspace availability (validated by
  the resolve/doctor suites, including refusal on missing or inconsistent
  disposition records). Manual state deletion or `sessionAdmission` bypass
  remains forbidden.
- GitHub Actions 3-platform matrix (Windows/macOS/Linux; Node 22, 24 if stable).
- Specialize on Unicode paths, long paths, file locks, case, symlink, junction, Ctrl+C,
  non-zero exit, large files, CAS corruption, interrupted rollback, workspace lock.
- **Review additions — structured dogfood gate (recorded, not vibes), before P5:**
  - **≥ 20 real AgentCommit sessions** total (**Alpha hard gate, amended by user
    instruction 20260909** — the original ≥50 figure is reclassified as a
    *continuing verification goal* and is no longer an unapproved Alpha blocker),
    of which:
    - ≥ 10 whole-session rollbacks,
    - ≥ 10 single-path restores,
    - ≥ 10 intentional conflict cases (rollback must refuse),
    - ≥ 5 agent interruption cases (Ctrl+C / kill),
    - ≥ 3 simulated interrupted-rollback cases (journal resume);
  - agent coverage: Z Code **plus** at least one other agent; Codex, Claude, and
    DeepSeek verified at least at adapter mock/smoke level;
  - **Windows carries a significant proportion of the sessions** (Windows-first is a
    headline differentiator, not an afterthought);
  - failure taxonomy recorded; **no unresolved P0/P1 restore/conflict defect** may
    remain before P5.

### P5 — open-source release

- npm name availability checked (OQ-01), then publish **alpha** (`v0.1.0-alpha.N`).
- MIT LICENSE, SECURITY.md (repo policy), CONTRIBUTING.md, issue/PR templates.
- README first screen: pain → 3 commands → successful restore, ≤ 20 s demo, including a
  real conflict case (post-session user edit refused by rollback).
- **Review additions — release safety statements, all mandatory in README and docs:**
  - the verbatim Git boundary sentence: *"V0.1 restores workspace file content only.
    It does not rewind Git history, index state, refs, commits, pushes, or
    external-world actions."*;
  - `agentcommit commit` ≠ `git commit`;
  - unprotected paths are always visible; "fully reversible" never claimed while any
    exist;
  - CAS is local-only, plaintext, not an encrypted vault; no current wipe path
    (`gc`/`purge` are reserved but disabled stubs);
  - external-world actions are not undoable.

## 3. Hard working rules (all phases)

1. Run `git status` before each phase; never `reset`/`checkout`/`stash` user changes.
2. Never touch two phases' core modules in one change.
3. Never delete old implementations to "simplify" unless the phase plan requires it.
4. Design gaps become Open Questions — never invented product promises.
5. Never weaken a safety check to make a test pass (e.g. auto-forcing conflicts).
6. Every phase ends with: changed files, tests, known risks, next-phase prerequisites —
   then a full stop.

## 4. Version roadmap after V0.1

| Version | Core capability | Why then |
| --- | --- | --- |
| V0.1 alpha → alpha.N | **Alpha Stabilization** (see §5) | Prove real users can trust rollback before any new capability |
| V0.2 | Permission engine: allow/ask/deny, protected paths, shell/git policy | Only after the Stabilization Gate |
| V0.3 | MCP proxy + `readonly / compensable / irreversible` classification | The real agent transaction layer |
| V0.4 | TUI / tray / rich review UI | Invest in UI only with real users |
| V0.5 | External connectors (GitHub/Calendar/Slack) compensation | Requires per-service inverse-action semantics |
| V1.0 | Stable API, plugin SDK, full security model, migration promises | Ecosystem standard |

Long-term moat: not "file backup" but the **Agent Action Transaction Model**
(reversible / compensable / irreversible) with unified review, permission, and
compensation policy. V0.1 data structures reserve room for it (TRANSACTION_MODEL §1)
without shipping premature complexity.

## 5. V0.1 Alpha Stabilization Gate (new — review addition)

**Rule: no new core features until this gate passes.** Stabilization exists to answer
one question: *do real users dare to run rollback?*

Exit criteria (all mandatory):

- ≥ 20 external installs;
- ≥ 10 external completed AgentCommit sessions;
- at least one external user has executed a real rollback;
- 0 unresolved P0 restore defects;
- 0 known silent-data-loss bugs;
- ≥ 2 patch releases shipped (e.g. `0.1.1-alpha`, `0.1.2-alpha`);
- triage summarized for: external issues, rollback failures, install failures,
  performance problems, confusion/UX issues.

Only after this gate may V0.2 (Permissions) begin.
