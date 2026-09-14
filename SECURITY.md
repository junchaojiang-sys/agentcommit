# Security Policy

## Reporting a vulnerability

Do **not** report vulnerabilities, credential leaks, out-of-scope writes,
security-boundary bypasses, or suspected data-loss bugs involving sensitive
data in a public issue. Use this table to pick the right channel:

| What happened | Where to report |
| --- | --- |
| Vulnerability, out-of-scope write, credential/privacy leak, security-boundary bypass | **GitHub private vulnerability reporting** (see below) |
| Suspected data loss involving sensitive business/personal data | **GitHub private vulnerability reporting** (see below) |
| Ordinary restore problems or data loss with non-sensitive synthetic content | **Recovery Incident** public issue form |

- **GitHub private vulnerability reporting** is the intended channel for the
  security rows above. It becomes available as soon as the public repository is
  created, and **it must be enabled before the npm publish and any public
  announcements** — until then the public README must not describe it as an
  already-available channel. After it is enabled, use
  *Repository → Security → Report a vulnerability*; do not attach credentials,
  workspace contents, or full state directories to the report.
- For ordinary (non-sensitive) restore problems, use the public **Recovery
  Incident** issue form instead — include `agentcommit doctor --report` output
  (metadata only; paths anonymized). Reports are metadata only: never attach
  workspace contents, credentials, or full state directories.

## What we consider in scope

- Restore writes to paths outside the session's recorded scope.
- Silent data loss: rollback reporting success while content was not restored.
- The content store (CAS) writing outside its state root, or restore following
  symlinks/junctions outside the workspace.
- State files (Session/Journal/Manifest) being mutated by any read-only command.
- Anything that makes `doctor` report a safe state when the persisted state is
  unreadable or unproven.

## What is by design (not a vulnerability)

- The CAS stores **plaintext** copies of protected files locally — documented
  (docs/STORAGE.md). It is a safety net, not an encrypted vault; keep secrets out of
  agent workspaces, or intentionally exclude them with `.agentcommitignore`. Note the
  security cost of exclusion: paths matched by `.agentcommitignore` are **not** stored
  in the plaintext CAS, but they are also **unprotected** — AgentCommit cannot diff,
  restore, or roll them back, and this boundary is disclosed in the Protection
  Summary. Exclusion keeps secrets out of the CAS; it does not keep them protected.
- V0.1 alpha provides **no working wipe path**: `gc` / `purge` are reserved but
  disabled stubs (docs/STORAGE.md §10), and plaintext CAS copies cannot currently be
  removed via AgentCommit.
- Rollback refuses on Current-drift instead of overwriting newer edits.
- Non-interactive runs fail closed on protection gaps.
- A refused restore reports that *this invocation* performed zero restore
  writes; the Journal is the authoritative record of what earlier attempts did.

## Supported versions

Alpha line `0.1.0-alpha.*` only. Security fixes land in the next alpha patch.
