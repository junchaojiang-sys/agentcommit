<!-- Title: <area>: <one-line change> -->

## What does this PR change?

## Why? (link the issue)

## Safety review checklist

- [ ] No safety check was weakened to make a test pass (conflict refusal,
      fail-closed admission, lock proof, journal resume).
- [ ] `agentcommit commit` still never touches Git (test exists and passes).
- [ ] No new network calls, telemetry, or data collection.
- [ ] Behavior changes to restore/snapshot semantics were discussed in an issue.
- [ ] Docs updated (docs/CLI.md for any CLI surface change; README for user-visible
      behavior).

## How was it tested?

```
<paste the exact commands>
```

- [ ] Full suite (`pnpm test`), not just targeted files, if snapshot/restore code changed.

## Rollback of this change

If this PR caused a problem, reverting it is: <!-- trivial / needs care because … -->
