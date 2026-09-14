# AgentCommit

**Transactional safety for AI coding agents.**

Run AI coding agents with a safety net. Review protected workspace changes.
Accept them, or roll them back safely. Resume interrupted restores without
guessing.

AgentCommit wraps the coding agents you already use (Codex, Z Code, Claude Code,
DeepSeek, or any command). Before your agent touches the workspace, the protected
files are saved; after it finishes, you review exactly what changed; and if you
roll back, AgentCommit refuses to overwrite edits that happened after the agent
run — and if a restore itself gets interrupted, a new process picks it up from a
durable journal instead of guessing.

**AgentCommit complements Git. It does not replace Git.** It protects the
uncommitted and untracked working-tree state that Git cannot restore for you —
including non-Git directories — while your agent works.

> **Alpha software (`0.1.0-alpha.1`).** The transaction core is real, heavily
> tested, and verified on Windows, Linux, and macOS CI, plus 20 real-agent
> dogfood sessions (Z Code and Codex) — see the [support matrix](#support-matrix).
> AgentCommit is not a backup product, not a model service, and not a Git
> replacement.

中文说明：[README.zh-CN.md](README.zh-CN.md)。

## Is this for you?

You will feel at home if any of these is you:

- You run coding agents (Codex, Claude Code, Z Code, DeepSeek, …) that execute
  shell commands and batch-edit files.
- You keep uncommitted, untracked, or non-Git files that an agent could
  overwrite, and Git cannot give them back.
- You have ever had an agent delete the wrong file or "refactor" the wrong
  directory, and you wanted the pre-run state back.
- You work on Windows natively (first-class, not an afterthought) — or on
  Linux/macOS.

## Install

```bash
npm install -g @agentcommit/cli
```

Requires Node.js 22+ (Node 24 works). No account, no API key. AgentCommit itself
runs fully locally — no telemetry, nothing uploaded. (Your *agent* talks to its
own model provider under its own terms; that traffic never passes through AgentCommit.)

## Three things AgentCommit does that you will actually use

Real commands, real output (recorded from the release candidate; the "agent" in
each demo is a synthetic one-line Node script standing in for your coding agent;
long JSON lines trimmed — full transcripts in [docs/demo-public/DEMOS.md](docs/demo-public/DEMOS.md)).

**Demo A — normal review and rollback.** Run `init` once per workspace; it never
overwrites.

```bash
mkdir ac-demo && cd ac-demo
agentcommit init
agentcommit run -- <your agent command>
agentcommit status
agentcommit diff
agentcommit commit     # accepts the session. NOTE: this is NOT a git commit.
# ...or put the workspace back the way it was:
agentcommit rollback
```

```text
$ agentcommit rollback
{"status":"succeeded",…,"completedPaths":["config.txt","util.py"],"conflicts":[]}
Whole session restored.
```

**Demo B — your newer edit wins.** After the agent finished, *you* edit the same
file. Rollback refuses, that attempt writes nothing, and your edit survives:

```text
$ agentcommit rollback
{"status":"rejected",…,"conflicts":[{"path":"app.ts",
  "kind":"user-modified-after-session",…}]}
RESTORE_REJECTED: preflight refused; no recovery actions were started by this
invocation.

$ type app.ts
user-edit            <- your newer edit is still there
```

**Demo C — interrupted restore resumes.** A rollback killed mid-restore leaves a
durable journal; the next `rollback` resumes it, and a third process formally
reloads the final state:

```text
[rollback killed mid-restore: yes]
$ agentcommit rollback
{"status":"succeeded",…}
Whole session restored.
$ # fresh-process formal reload
{"status":"rolled_back","journal":"completed","receipts":400}
```

Detailed, untrimmed transcripts and the scripts that produced them:
[docs/demo-public/DEMOS.md](docs/demo-public/DEMOS.md). Synthetic agents are always labeled as such.

## What rollback does when things get complicated

- **You edited a file after the agent finished?** Rollback refuses by default —
  your newer edit wins and that attempt writes *nothing*. Review with
  `agentcommit status`, restore just the safe paths with
  `agentcommit restore <path>`, or decide explicitly with the interactive Force
  flow.
- **The restore itself was interrupted** (process crash, process termination,
  killed process)? Run `agentcommit rollback` again. Completed actions are
  skipped, pending ones continue — based on a durable journal, not on hope.
- **Something looks wrong?** `agentcommit doctor` is a read-only diagnosis of the
  workspace and saved state; `doctor --report` writes a sanitized local report you
  can read before sharing.

## What AgentCommit does NOT do

Read this before trusting it with real work:

- `agentcommit commit` is **not** `git commit`. It accepts an AgentCommit session
  and never touches Git history, index, refs, or pushes.
- Rollback restores **workspace file content only** — the paths captured as
  protected in that session. It does not undo emails, payments, deployments, API
  calls, or any other external-world action your agent performed.
- Only protected paths are recoverable. Unprotected paths (too large, unreadable,
  symlink-policy-rejected) and ignored boundaries are shown in the Protection
  Summary — "fully reversible" never applies while any of them exist.
- When current file state changes after planning, AgentCommit may refuse the
  **entire selected restore scope**, not just the one path. That refusal means
  *this attempt* performed zero restore writes — it does not mean no restore
  action ever ran in earlier attempts; the Journal is the record of what happened.
- No writer attribution: within one run window AgentCommit cannot tell your
  agent's edit from your editor's save; detached or background processes may keep
  writing after the agent's main process exits, and those writes are not
  guaranteed to be captured.
- It is not an atomic filesystem snapshot and does not provide power-loss-grade
  whole-machine transactional durability.
- Committing (accepting) a session is final for that session: a later session's
  rollback does not reach back into it.
- The CAS content store is local-only and **plaintext** — a safety net, not an
  encrypted vault. Don't point agents at secrets you cannot keep on disk.

## Support matrix

Verified with the current release candidate (`0.1.0-alpha.1`): full test suite
and GitHub Actions CI across ubuntu-latest / windows-latest / macos-latest ×
Node 22/24 (latest main run `34420672968`, 6/6 green, per-job results archived);
plus 20 real-agent dogfood sessions — 18 with Z Code (Windows, GLM) and 2 with
Codex (Windows, ChatGPT plan) covering commit, rollback, single-path restore,
conflict refusal, real Ctrl+C interruption, and interrupted-restore resume.

| Capability | State |
| --- | --- |
| Windows (native), Node 22/24 | **Verified** — full local suite + Windows GitHub-hosted CI (windows-latest); local development on Windows 11 |
| Linux (x64), Node 22/24 | **Verified** — CI matrix (ubuntu-latest) |
| macOS, Node 22/24 | **Verified** — CI matrix (macos-latest) |
| Z Code (real agent) | **Verified** — 18 real sessions |
| Codex (real agent) | **Verified** — 2 real sessions |
| Generic synthetic agent | **Verified** — used by the automated suites |
| Claude Code / DeepSeek / other adapters | **Adapter implemented; synthetic-only so far** — no real-agent runs yet |
| POSIX ordinary-file rwx restore | **Supported, CI verified** — rwx bits captured, restored and verified on rollback; mode-only changes and post-plan chmod drift recognized. Boundaries: special bits, ownership, xattrs, ADS and mtime are out of scope |
| Symlinks / junctions | Windows junctions verified in suite; POSIX symlink restore verified by CI |

Competitive comparisons, where present, name their source or say NOT TESTED.

## How it works (30 seconds)

`run` snapshots protected files into a local content-addressed store (Pre), runs
your agent as a direct child process, snapshots again (Post), and computes a
ChangeSet. You review; `commit` accepts, or `rollback` builds a restore plan from
Pre→Post and executes it journalled action by action. If `Current` no longer
matches `Post` for a path, that path conflicts and the default is to refuse rather
than overwrite your newer work. Details: [docs/TRANSACTION_MODEL.md](docs/TRANSACTION_MODEL.md).

## Privacy

No telemetry, no uploads, no conversation transcripts collected — AgentCommit has
no network calls at all. Diagnostics (`doctor --report`) are generated **locally**
from a metadata whitelist and are never uploaded automatically; you can read the
report file before deciding to share it (it excludes raw error text, user paths,
hostnames and session identifiers by design). Security reporting:
[SECURITY.md](SECURITY.md) — vulnerabilities and security-boundary issues go
through GitHub private vulnerability reporting (enabled when the public
repository is created, before npm publish); never in public issues.

## Status & feedback

Alpha. Where a report belongs depends on what happened:

- **Ordinary restore problems, unexpected behavior, or suspected data loss
  without sensitive information involved** → use the **Recovery Incident**
  issue form (metadata only — never attach workspace contents, credentials,
  full state directories, or sensitive logs).
- **Security issues** — a vulnerability, an out-of-scope write, a
  credential/privacy leak, or any security-boundary bypass → **GitHub private
  vulnerability reporting** (see [SECURITY.md](SECURITY.md)). Never in a public
  issue. Note: private vulnerability reporting becomes available as soon as the
  public repository is created; it must be enabled before the npm publish and
  any announcements.

See [CONTRIBUTING.md](CONTRIBUTING.md). Project docs:
[docs/PRODUCT.md](docs/PRODUCT.md), [docs/CLI.md](docs/CLI.md),
[docs/ROADMAP.md](docs/ROADMAP.md).

## Development

Requires Node.js ≥ 22 and pnpm (see `packageManager` field).

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm smoke
```

## License

[MIT](LICENSE).
