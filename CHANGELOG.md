# playwright-ai-triage

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
