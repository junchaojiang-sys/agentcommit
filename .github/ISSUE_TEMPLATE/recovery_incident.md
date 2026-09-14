---
name: Recovery incident
about: A restore behaved unexpectedly, or you suspect data loss
labels: recovery,data-loss-suspect
---

**If you suspect active data loss right now: stop running agents in the affected
workspace and keep the AgentCommit state directory untouched — do not delete locks,
sessions, journals, or blobs.** The exact location is printed by `agentcommit doctor`
(`stateRoot`; default `%LOCALAPPDATA%\AgentCommit` on Windows, overridable via
`AGENTCOMMIT_STATE_DIR`).

## Environment

- AgentCommit version (`agentcommit --version`):
- OS + version:
- Node version:
- Agent and command line used (redact private values):

## What were you trying to do?

## What actually happened?

## Timeline (as exact as you can)

1. Session started at / command:
2. Agent finished / was interrupted:
3. What you ran next (status / diff / rollback / restore):
4. Where it went wrong:

## Recovery result category

- [ ] rollback reported success, but content was not restored
- [ ] rollback reported success, but something ELSE changed
- [ ] rollback refused, and I believe it should not have
- [ ] rollback refused, correct behavior, but the messaging was confusing
- [ ] restore interrupted and resume failed
- [ ] other

## Evidence

- [ ] I ran `agentcommit doctor --report <file>` — paste the report (metadata only,
      paths anonymized). Review it before attaching.
- Current file contents for the affected path(s), if safe to share (BEFORE/AFTER):

**Do not attach:** workspace contents, full state directories, CAS blobs, prompts,
transcripts, or anything with credentials. Do **not** include model configuration
or authentication values.

**Security note:** if the incident involves a vulnerability, an out-of-scope
write, a credential/privacy leak, or sensitive business data, do not use this
public form — use GitHub private vulnerability reporting instead (see
SECURITY.md).
