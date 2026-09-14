# CLI.md — Frozen V0.1 Command Surface and Semantics

> Normative CLI specification, frozen during the Phase 0 review rectification
> (2026-09-05). The stubs in `packages/cli` mirror this file. Any command or flag not
> listed here is out of scope for V0.1.

> P3 user decisions (2026-09-08): English output; `run --allow-unprotected`
> explicitly permits disclosed gaps in noninteractive mode (otherwise refused);
> zero Post grace delay; no automatic pruning. `restore` accepts one path scope
> per invocation, including a directory prefix. Multiple scopes are refused before
> execution. `gc` and `purge` remain disabled pending separate authorization for
> global safe cleanup; their presence in help does not mean deletion is implemented.

## Command surface

| Command | Purpose | Notes |
| --- | --- | --- |
| `agentcommit init` | Create workspaceId, `.agentcommit.json`, `.agentcommitignore` template | |
| `agentcommit run [--agent <name>] [--allow-unprotected] -- <cmd...>` | Resolve workspace → acquire lock → pre-snapshot → Protection Summary → spawn → post-scan → review | Signal forwarding; non-zero agent exit still produces a reviewable session |
| `agentcommit status` | Current/latest session summary | Includes protection status |
| `agentcommit diff [path]` | Text diff for text files; hash/size for binaries | Local rendering only |
| `agentcommit commit` | **Accept / finalize the AgentCommit session** | See semantics below — never touches Git |
| `agentcommit rollback [--force]` | Deterministic, journal-resumable restore of the session | Conflict-refusing by default; `--force` double-confirmed |
| `agentcommit restore <path> [--force]` | Conflict-checked single-scope restore | Same 3-way rules; multiple paths refused in P3 |
| `agentcommit history` | List past sessions | |
| `agentcommit show <id>` | One historical session's detail | |
| `agentcommit doctor` | Environment diagnostics | |
| `agentcommit gc` | DISABLED in 0.1 alpha — stub only; performs no cleanup. | Reserved surface; retention decision: OQ-11 |
| `agentcommit purge` | DISABLED in 0.1 alpha — stub only; performs no deletion. | Reserved surface; separate future authorization required |
| `agentcommit unlock --session <id>` | Remove a **proven-stale** workspace lock | Requires typing the session id; never automatic |
| `agentcommit agent add <name> --command <cmd>` | Register a named agent launch command | User-configurable; nothing hardcoded |
| `agentcommit agent list` / `agentcommit agent remove <name>` | Manage registered agents | |

## `agentcommit commit` semantics (frozen)

`commit` means exactly: **the user accepts this AgentCommit session and the transaction
is marked `committed`.** It must never:

- run `git add` (or stage anything),
- run `git commit` or create any Git commit,
- create, move, or delete branches,
- touch refs, the index, or any Git state.

Required output, printed on every `commit`:

```
AgentCommit transaction accepted.
This did NOT create a Git commit.
```

(Whether a future minor version may offer an explicit opt-in `--git-commit` flag is
tracked in docs/OPEN_QUESTIONS.md — it must not exist in V0.1.)

## `agentcommit run` gating

1. **Resolve the workspace.** Starting from the current working directory, walk up
   parent directories to the nearest `.agentcommit.json`; that directory is the
   workspace root and its workspaceId keys everything that follows. Reaching the
   filesystem root without a match fails closed with `WORKSPACE_NOT_INITIALIZED` —
   no auto-`init` (only `agentcommit init` creates a workspace).
2. **Workspace lock.** Acquired on that identity before the pre-scan; a valid
   existing lock fails closed with `WORKSPACE_LOCKED` (TRANSACTION_MODEL §3).
3. **Protection Summary.** After the pre-scan, the summary is printed. Interactive
   sessions are asked `Continue?`; non-interactive behavior follows OQ-05's decision.
   The agent process starts only after this gate.

Convenience command strings (e.g. `agentcommit agent add deepseek --command "python
-m deepseek_harness"`) are parsed at the CLI boundary into `executable + argv`;
AgentCommit never shell-evaluates them (ARCHITECTURE §5.3).

## `agentcommit rollback` / `restore` rules

- Conflicts are **refused by default**; `--force` exists but is off by default and
  requires a second, explicit confirmation (listing affected path counts, typing the
  session id suffix). Never weakened for UX.
- Rollback is deterministic, idempotent, retryable, and resumable via the Restore
  Journal (TRANSACTION_MODEL §7–8). Re-running `rollback` after an interrupted attempt
  skips already-restored-and-verified actions and continues.
- Success is declared only when all six success conditions hold
  (TRANSACTION_MODEL §9) — never merely because the command finished.

## Error reporting

All failures print a stable `AgentCommitError` code (`CONFLICT`, `BLOB_MISSING`,
`BLOB_CORRUPT`, `STATE_CORRUPT`, `WORKSPACE_LOCKED`, …) plus a human explanation.
Non-zero exit codes on every refusal; exit code `2` is reserved for "refused / not
performed by policy" (including the Phase 0 skeleton stubs).

## P3 execution boundary

- Recovery results print the exact core status: `succeeded` (exit 0), `partial`
  or `retryable` (exit 1), `rejected` (exit 2). Partial/retryable can include an action
  whose effect was not yet recorded. Scoped success explicitly leaves the Session open.
- `run` preserves a normal child exit code, including nonzero exits, after Post/review.
  Forwarded SIGINT/SIGTERM use 130/143; the Wrapper waits for child closure before Post.
  A hard-killed Wrapper leaves persisted state for inspection; a new run refuses an
  unfinalized Session. Unlocking a dead process does not finish its transaction.
- CLI Force uses the displayed plan, complete conflict fingerprints and two prompts
  (type `yes`, then the final 8 characters of Session id). Noninteractive Force cannot
  authorize conflicts. Core independently rejects drift or invalid bindings after prompts.
- Explicit argv after `--` is a complete executable plus arguments, overriding a
  registered/default command. Without argv, `--agent <name>` uses its registered
  command, or the Codex/Claude convenience default. Z Code/DeepSeek require configuration.
- Command strings group whitespace with single/double quotes; quotes are removed,
  backslashes are literal, and empty quoted arguments are preserved. No shell expansion,
  variable interpolation, globbing, or escape-language evaluation occurs. For complex
  argument quoting, pass direct argv after `--`.
- Version probing is an explicit adapter API (`detectCommand`), bounded by time/output;
  `run` does not launch a second copy of an unknown command merely to discover its version.
  Uncollected versions stay absent. `.cmd`/`.bat` launchers are not shell-wrapped as a fallback;
  use a directly executable binary or `node` plus a JavaScript entry point.
- Agent integration verification status (2026-09-12): **Z Code real-agent
  verified** (18 dogfood sessions) and **Codex real-agent verified** (2 sessions);
  Claude Code / DeepSeek adapters remain **synthetic-only** (implemented and covered
  by synthetic tests, no real-agent runs yet). Verification is per product line as
  listed — it does not extend to every product/version combination.
