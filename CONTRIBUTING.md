# Contributing

Thanks for looking at AgentCommit. It is an alpha project with a frozen safety
model — please read the ground rules before opening a pull request.

## Ground rules

1. **Never weaken a safety check to make a test pass.** Conflict refusal,
   fail-closed admission, lock proofs, and journal resume are the product.
2. Restore semantics are specified in [docs/TRANSACTION_MODEL.md](docs/TRANSACTION_MODEL.md).
   Behavior changes there need an issue discussion first.
3. Every behavior fix ships with a test that fails without it.
4. `agentcommit commit` must never touch Git. There is a test for that; keep it.
5. No telemetry, no network calls from the CLI, no data collection — this is a
   design promise, not a config option.

## Workflow

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm -r build && pnpm test && pnpm smoke
node docs/scripts/ci-synthetic-flow.mjs   # synthetic end-to-end flow
```

- Keep diffs minimal and scoped to one concern.
- New CLI surface needs a docs update in [docs/CLI.md](docs/CLI.md).
- If you touch anything restore- or snapshot-related, run the full suite, not just
  the targeted file.

## Reporting bugs

Use the Bug Report issue form. Suspected data loss or unexpected restore results
belong in the **Recovery Incident** form — include `agentcommit doctor --report`
output (metadata only; never attach workspace contents). Security issues: see
[SECURITY.md](SECURITY.md) — never in public issues.

## Alpha expectations

During alpha, triage prioritizes: (1) data loss and wrong-overwrite reports,
(2) restore/conflict correctness, (3) platform-specific failures, (4) UX.
There is no response-time guarantee.
