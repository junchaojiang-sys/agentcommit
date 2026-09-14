---
name: Bug report
about: Something misbehaved (use the Recovery Incident form for restore/data-loss issues)
labels: bug
---

## Environment

- AgentCommit version (`agentcommit --version`):
- OS + version:
- Node version (`node --version`):
- Agent you wrapped, and how it was launched (command line; redact anything private):

## What happened

**Steps to reproduce** (minimal, synthetic agents preferred):

```
1.
2.
3.
```

**Expected result:**

**Actual result:** (paste the real CLI output; trim long JSON, keep the command lines)

**Exit codes** of `agentcommit run` / `rollback` / `restore`, if applicable:

## Recovery result category

- [ ] rollback succeeded
- [ ] rollback refused (conflict)
- [ ] rollback partial / retryable
- [ ] restore interrupted, resumed
- [ ] n/a

## Diagnostics (optional but very helpful)

Attach `agentcommit doctor --report <file>` output. It is a whitelisted metadata
report (versions, statuses, counts) with paths anonymized — please review it before
attaching. Do **not** attach workspace contents, full state directories, or logs
containing private code.

- [ ] Suspected data loss? If yes, please use the Recovery Incident form instead.

**Never include in this issue:** credentials, tokens, model configuration files,
authentication headers, full environment dumps, or sensitive business data.
Security vulnerabilities, out-of-scope writes, or privacy leaks belong in
**GitHub private vulnerability reporting**, not here (see SECURITY.md).
