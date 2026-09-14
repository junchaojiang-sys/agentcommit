# OPEN QUESTIONS — Product Decision Register

> Rule (review 2026-09-05): unresolved **product** decisions are never made by the
> implementer. Each question is recorded here with options, security implications, and a
> recommended default — and waits for explicit user approval. Implementer-owned
> engineering choices are listed separately at the bottom for transparency.

Status legend: `OPEN` (awaiting user) · `DECIDED` (user-approved, recorded in specs).

---

## Decisions (user-approved 2026-09-05, P0 closeout)

### OQ-03 — `.gitignore` inheritance — **DECIDED: Option A**
- **Decision:** `.gitignore` is **never** inherited as an AgentCommit exclusion source.
  Built-in defaults + `.agentcommitignore` are the only exclusion sources.
  `.gitignore` may be read for **performance hints in warnings only** — never to reduce
  protection.
- **Recorded in:** STORAGE §4, PRODUCT §3, ROADMAP P0.

### OQ-04 — Secret-looking files — **DECIDED: Option A**
- **Decision:** `.env`, credential files, private keys, token caches, and local
  databases are **protected like any other file by default**. The local CAS therefore
  holds plaintext copies of them; that risk is disclosed prominently (README,
  SECURITY, STORAGE). There is **no current cleanup mitigation** — `gc`/`purge` are
  reserved but disabled stubs in 0.1 alpha (STORAGE §10) — and encryption at rest
  remains a future hardening item (explicitly not in V0.1).
- **Recorded in:** STORAGE §7, SECURITY §2.6, PRODUCT §3.

### OQ-06 — Per-project large-file cap override — **DECIDED: Option A**
- **Decision:** `.agentcommit.json` may override the 100 MB default
  (`maxFileSizeBytes`); the effective cap is always shown in the Protection Summary —
  an override can never be silent.
- **Security implication (corrected 2026-09-05):** raising `maxFileSizeBytes` does
  **not** exclude more files — it **extends protection** to files between the old and
  new caps (previously unprotected files become protected). Lowering the cap
  **increases** the number of unprotected files. Raising the cap mainly costs
  snapshot time, disk usage, and resource pressure.
- **Recorded in:** STORAGE §5, ROADMAP P0/P1.

### OQ-12 — `.agentcommitignore` pattern semantics — **DECIDED: gitignore-style (Option A semantics)**
- **Decision:** `.agentcommitignore` uses **gitignore-style pattern semantics**
  (negation, anchoring, `**`), matching user expectations from Git.
- **Implementation note (implementation commitment removed 2026-09-05):** *how* the
  matcher is implemented is an **engineering decision** (tracked as IQ-03), not a
  product promise. A mature, battle-tested implementation is preferred. If the chosen
  implementation cannot fully honor documented gitignore semantics, the supported
  subset MUST be explicitly documented and covered by compatibility tests. Claiming
  full gitignore compatibility without meeting it is prohibited.
- **Recorded in:** STORAGE §4, ROADMAP P0/P1.

---

## Decisions (user-approved 2026-09-08, P2B)

> Scope note (historical, 2026-09-08): these P2B decisions did not authorize
> P3/runtime implementation or publication at the time they were made.
> **Superseded status (2026-09-12):** P3, P4 and P5 preflight have since been
> user-authorized and completed — see ROADMAP status header.

### OQ-07 — Executable bit / mode restore policy — **DECIDED: Unix regular-file rwx bits**
- **Decision:** On Unix, restore and verify the recorded `rwx` permission bits for
  regular files (`mode & 0o777`). Any supported mode-restore or verification failure
  is an error; it is never silently ignored. Do not restore special mode bits,
  ownership, extended attributes, alternate data streams, or `mtime`. Do not follow a
  symlink to apply `chmod`. Windows ACL restoration is not promised in V0.1.
- **Implementation status (updated 2026-09-12):** ordinary regular-file rwx bits are
  captured at scan, restored on rollback, and verified — **CI-verified on Linux and
  macOS runners** (Windows skips rwx restore by design, no ACL promise), plus
  real-agent dogfood coverage. Mode-only changes and post-plan chmod drift are
  recognized as documented. Special bits, ownership, xattrs, ADS and `mtime` remain
  out of scope.
- **Recorded in:** TRANSACTION_MODEL §2.1 and STORAGE §8.

### OQ-08 — Scope of `rollback`/`restore` — **DECIDED: latest recoverable session only**
- **Decision:** A restore may write only to the current workspace's latest session that
  is both unfinalized and recoverable. If that session is unavailable, corrupt,
  finalized, or otherwise cannot be recovered, the command rejects the request and
  never falls back to an older session.
- **Implementation boundary:** `prepareRestore` and `executeRestore` reselect and bind
  the latest Session, enforce the workspace lock, and reject unknown, ambiguous, or
  unsafe latest-session/Journal state.
- **Recorded in:** TRANSACTION_MODEL §§1.1, 9 and STORAGE §2.

### OQ-09 — Repair surface for `rollback_failed` — **DECIDED: one executor and journal**
- **Decision:** Whole-session restore, single-path restore, and retry all use the same
  `executeRestore` executor and Restore Journal. There is no second `repair` command or
  separate repair algorithm. A successful single-path operation records its completed
  path but does not finalize the entire session as `rolled_back`.
- **Implementation boundary:** completed scoped Journals are archived at
  `journal-history/<sessionId>/<planId>.json`; a later whole-session Journal accepts
  only receipts that bind to the source plan, attempt, action, and expected fingerprint,
  then re-observes Current.
- **Recorded in:** TRANSACTION_MODEL §§1.1, 9–10 and STORAGE §2.

---

## Decisions (resolved through P3 closeout, 2026-09-08)

### OQ-01 — npm package name — **DECIDED: scoped packages (user-approved 2026-09-12, P5)**
- **Decision:** Publish as `@agentcommit/core`, `@agentcommit/adapters`, and
  `@agentcommit/cli` (scoped public packages, `--access public --tag alpha`);
  the CLI binary name is **`agentcommit`**.
- **Registry status (2026-09-12):** all three names 404 — unclaimed.
- **Recorded in:** RELEASE_CANDIDATE_MANIFEST.json, ALPHA_RELEASE_CHECKLIST.md,
  NPM_PUBLISH_COMMANDS.txt.

### OQ-02 — CLI output localization — **DECIDED: English CLI**
- **User decision (P3):** English CLI output; no i18n scaffolding in this phase.
- **Security implication:** i18n adds surface area for mistranslated safety messages; safety-critical strings should stay canonical.

### OQ-05 — Non-interactive behavior when unprotected changes will exist — **DECIDED: Option B**
- **User decision (P3):** Non-interactive execution refuses unprotected paths by default; explicit `--allow-unprotected` permits continuation after the full summary.
- **Security implication:** warn-and-continue risks automation users overlooking unrecoverable paths; fail-closed breaks the primary CI/agent-script use case whenever one large artifact exists, tempting users to blanket-disable checks.

### OQ-10 — Grace period for background child-process writes — **DECIDED: Option A**
- **User decision (P3):** No wait after the main child exits (0 seconds); disclose that background descendants can still write outside the observed lifecycle.
- **Security implication:** no-wait may miss straggler writes (they surface as "user modified after session" conflicts at rollback — annoying but safe); a grace period delays every session and still guarantees nothing.

### OQ-11 — Session/manifest retention for `gc` — **DECIDED: Option A**
- **Decision:** no automatic pruning; data retention is **keep-all in V0.1 alpha**
  (no age/count deletion policy). The `gc` / `purge` command surface is **reserved
  but disabled in 0.1 alpha** — invoking them deletes nothing — and cleanup
  implementation requires separate future authorization.
- **User decision (P3):** No automatic pruning. Keep data until explicit `gc` / `purge`; no age/count deletion policy.
- **Security implication:** keep-all grows the plaintext secret copies on disk over time (see OQ-04); auto-prune risks deleting a restore point someone still wanted.

---

## Implementer-owned engineering decisions (transparency, not user-blocking)

P3 scope clarification approved separately by the user on 2026-09-08: one restore
path scope per invocation; `gc`/`purge` remain explicit refusals pending separate
authorization. No global concurrent cleanup algorithm is added in P3.

IQ-02 P3 implementation: Node spawn with shell=false, no new dependency. Synthetic
Node child tests cover literal argv, nonzero exit, signal delivery and Session
lifecycle; actual console behavior and named Agent versions are separately bounded.

| ID | Decision | Needed by | Notes |
| --- | --- | --- | --- |
| IQ-01 | Which JS diff library (leading candidate: `diff`/jsdiff) | Phase 2 | Own formatter on top; binary files never get text diffs |
| IQ-02 | execa vs hand-rolled spawn wrapper | Phase 3 | Decided by a signal-forwarding (Ctrl+C) spike on Windows; the wrapper must satisfy the subprocess safety rules (ARCHITECTURE §5.3) |
| IQ-03 | `.agentcommitignore` matcher implementation | Phase 1 | Engineering decision per OQ-12: prefer a mature, proven gitignore-style matcher; any supported subset must be documented and covered by compatibility tests |
