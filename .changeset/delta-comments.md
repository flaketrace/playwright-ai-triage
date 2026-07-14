---
'playwright-ai-triage': minor
---

Cross-run delta in the PR comment, with zero external state:

- Findings are now labeled against the previous run: 🆕 new failures get full
  detail, ⏳ persisting failures collapse to a single line instead of being
  re-announced, and a `✅ N failure(s) resolved since the last run` line
  appears when failures disappear.
- A green run flips the previous red comment to a short "all clear ✅" state —
  the report is always a snapshot of the current run; fixed means gone. PRs
  that never had failures still get no comment at all.
- The only state is an invisible, versioned fingerprint block embedded in the
  tool's own comment (`<!-- playwright-ai-triage:fps:v1 … -->`). No files, no
  database, nothing leaves the PR. Comments posted by older versions simply
  render unlabeled once, then pick up delta labels from the next run on.
