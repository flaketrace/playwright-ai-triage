# playwright-ai-triage

## 0.3.0

### Minor Changes

- e9374b6: Cross-run delta in the PR comment, with zero external state:

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

- e9374b6: Failure fingerprints (R2): `failureFingerprint()` / `normalizeErrorSignature()` give
  every failure a short stable identity — same test + same error shape ⇒ same id, with
  volatile parts (numbers, timestamps, UUIDs, hex ids, URL query strings) masked. The
  primitive behind cross-run NEW/PERSISTING/RESOLVED delta labeling.

### Patch Changes

- e9374b6: Honesty polish in the summaries, plus the "after a fix" workflow docs:

  - The headline no longer counts UNCLASSIFIED failures as "triaged" — they are
    reported separately (`2 failure(s) triaged · 1 unclassified`), matching the
    fail-closed philosophy.
  - Keyless runs no longer print a model name on the cost line: nothing was
    called, so the line reads `$0.0000 (no API calls made)`.
  - README: fork-PR token limitation documented (read-only `GITHUB_TOKEN` skips
    the PR comment; stdout still works) and a new "After a fix" section describing
    the targeted re-run loop (`--last-failed` → resolved/persisting labels →
    all-clear).

## 0.2.0

### Minor Changes

- 4210f0e: Classify script-decidable failures locally without any API call: passed-on-retry → FLAKY,
  pure network signatures → ENV_ISSUE (as before), and explicit expired-credential errors →
  ENV_ISSUE. The LLM is now reserved for failures that need judgment (assertion diffs, locator
  timeouts). The summary notes how many failures were classified locally at zero token cost.

  Keyless runs now benefit too: without ANTHROPIC_API_KEY the reporter still applies the
  deterministic local verdicts (previously it skipped classification entirely and printed
  only the plain summary); rich outputs stay disabled without a key.

  Classifier prompt v002 (first dogfood round): deterministic element-absence with no
  rename evidence now prefers hedged ENV_ISSUE (feature flag / environment config) over
  SELECTOR_DRIFT, suggestedFix may name the flag/env var to check for config-type
  ENV_ISSUE, and confidence is calibrated (two plausible classes ⇒ ≤0.5).

## 0.1.0

### Minor Changes

- 82f623d: First functional release: LLM failure classification (REAL_BUG / FLAKY / SELECTOR_DRIFT /
  ENV_ISSUE) with heuristic pre-pass and fail-closed degradation, stdout summary, GitHub PR
  comment upsert, and Slack Block Kit output. The reporter never affects your build's exit code.

Releases are managed with [changesets](https://github.com/changesets/changesets); entries appear
here automatically on publish.

## 0.0.1

Name reservation and project skeleton. Not functional yet.
