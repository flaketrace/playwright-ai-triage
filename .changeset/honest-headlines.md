---
'playwright-ai-triage': patch
---

Honesty polish in the summaries, plus the "after a fix" workflow docs:

- The headline no longer counts UNCLASSIFIED failures as "triaged" — they are
  reported separately (`2 failure(s) triaged · 1 unclassified`), matching the
  fail-closed philosophy.
- Keyless runs no longer print a model name on the cost line: nothing was
  called, so the line reads `$0.0000 (no API calls made)`.
- README: fork-PR token limitation documented (read-only `GITHUB_TOKEN` skips
  the PR comment; stdout still works) and a new "After a fix" section describing
  the targeted re-run loop (`--last-failed` → resolved/persisting labels →
  all-clear).
