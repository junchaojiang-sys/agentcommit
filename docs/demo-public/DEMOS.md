# Demos — real transcripts, synthetic agents

Every transcript here was captured by [docs/scripts/p5a-install-verify.mjs](<internal verification script; see CONTRIBUTING.md>)
against `@agentcommit/cli` **installed from the release-candidate tarballs** (not from
the repo checkout). The "agent" in every demo is a one-line Node script — a
**synthetic agent**, never a real model agent. User-account paths in the published
copies are redacted as `<temp>`; redaction touches only path display, never command
results.

| File | Scenario | What it shows |
| --- | --- | --- |
| [demo-A-normal-restore.txt](demo-A-normal-restore.txt) | Normal restore | init → agent edits 2 files → Protection Summary → diff → rollback → contents restored |
| [demo-B-user-edit-kept.txt](demo-B-user-edit-kept.txt) | Your newer edit wins | agent edit → your edit → rollback **refused** → zero restore writes → your text intact |
| [demo-C-interrupted-restore.txt](demo-C-interrupted-restore.txt) | Interrupted restore resumes | 400-file change → rollback killed mid-restore → rollback again resumes from the journal → a third process formally reloads the final Journal/Session |
| [p5a-install-verify-transcript.txt](p5a-install-verify-transcript.txt) | Full install verification | the complete 11-step acceptance run (install → version/help → init → modified/created/deleted → status/diff → commit ≠ git commit → restore/rollback → conflict refusal → formal reload → doctor → README quickstart) |

## Reproduce

```bash
node docs/scripts/p5a-pack-candidates.mjs     # build candidate tarballs
node docs/scripts/p5a-install-verify.mjs      # fresh-dir install + all checks + demos
```

Both scripts are deterministic; timestamps and random session IDs will differ.
