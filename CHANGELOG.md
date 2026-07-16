# playwright-ai-triage

## 0.4.0

### Minor Changes

- b26f8b8: Prior-attempt evidence in classification payloads: each entry in a failure's
  retry history now carries a short error head for earlier attempts whose error
  differs from the reported one (ANSI-stripped, secret-redacted, truncated to
  300 chars). Previously the classifier saw only the final attempt's error — a
  failure whose first two attempts died on backend 500s and whose last attempt
  hit a bare timeout looked like "just a timeout" to the model. Identical
  repeats are skipped (no signal beyond their status, only token cost), and the
  reported attempt's error is never duplicated (it is already the payload's
  errorMessage). The README data-flow disclosure is updated accordingly.

## 0.3.6

### Patch Changes

- 8cd296f: Classifier prompt v005: REAL_BUG now distinguishes test-side vs product-side
  cause when diffSummary is provided. Previously a deterministic assertion-diff
  was always classified REAL_BUG with no suggestedFix, leaving the reader to
  work out unaided whether the app regressed or the test's own hardcoded
  expected value was what changed. New rule 5: when the diff is confined to the
  failing test's own spec file or a shared test helper (a formatter, fixture
  builder, constant) rather than app/product source, the classifier now says so
  in `why` and gives REAL_BUG a `suggestedFix` pointing at verifying that
  recent test-side change against live behavior first. Found via a real dogfood
  case: a Playwright suite's scheduled-update banner assertion expected a
  long-form date string a prior test-only commit had introduced, while the app
  still rendered its original short-form date — REAL_BUG was technically
  correct but gave no hint the fix belonged in the test, not the app.

## 0.3.5

### Patch Changes

- c6f3fca: Rebrand: the PR-comment header now uses 🔍 instead of 🧭. The compass read as
  an MCP/agent-tool symbol and was easy to confuse with unrelated tooling; a
  magnifying glass better signals "classifies your failures."

## 0.3.4

### Patch Changes

- ab812b2: Rebrand: the PR-comment header now uses 🔍 instead of 🧭. The compass read as
  an MCP/agent-tool symbol and was easy to confuse with unrelated tooling; a
  magnifying glass better signals "classifies your failures."

## 0.3.3

### Patch Changes

- c536d9a: Prompt v004 + heuristics: classify backend `5xx`/`409` on setup/seed calls as `ENV_ISSUE`, not `REAL_BUG`.

  A dogfood round against a real backend-outage CI run showed the classifier stamping every backend `500`/`503`/`409` as `REAL_BUG` (the taxonomy listed bare "API 4xx/5xx from the app under test" as `REAL_BUG` evidence). On an 11-case eval built from those real failures the shipped prompt scored 46% weighted with ~5 false `REAL_BUG` alarms per run.

  - `heuristics.ts`: the suite's own transient-retry wording (`TransientHttpError`, `retryOnTransient`, "HTTP 5xx/409 after N attempts") is now a deterministic local `ENV_ISSUE` verdict — model-independent and free (no tokens). Added `socket hang up` / `upstream connect error` / `disconnect/reset before headers` to the network signatures.
  - `prompt.ts` (v004): server errors are `ENV_ISSUE` by default (`REAL_BUG` only for the exact endpoint the test asserts on, tied to the code under test); new batch-wide-outage rule; the absence rule now covers seeded/expected entities.

  On the same eval this lifts weighted accuracy to ~97% with 0 dangerous misses and slightly lower cost. The genuine-bug control still classifies as `REAL_BUG` (no over-correction).

## 0.3.2

### Patch Changes

- 1812dc5: Prompt v003: an element's absence is not drift evidence. The classifier no
  longer reads a DOM snapshot that merely _lacks_ the target element as a
  SELECTOR_DRIFT signal — a bare page (or one whose visible elements are unrelated
  to the target) is the ambiguous case, equally consistent with a real bug that
  failed to render, a disabled flag, or a load failure. Positive rename evidence
  (a different element serving the same role/purpose in the snapshot, or a diff
  touching that component) remains what a confident SELECTOR_DRIFT call requires.

## 0.3.1

### Patch Changes

- 3fb2c7c: Two collector-fidelity fixes surfaced by real Playwright output:

  - **Strip ANSI escape codes** from error messages and stacks. Playwright
    colourises assertion errors, and those SGR codes were ~20% of the raw error
    text — pure noise sent to the model (~200 wasted tokens per run). They are now
    stripped before redaction, so both the classifier and the secret patterns see
    clean text.
  - **Fix `includeDom` on modern Playwright.** Playwright ≳1.53 emits the page
    aria snapshot as a fenced ```yaml block in the error-context attachment rather
    than under a `# Page snapshot` heading, so `includeDom` silently captured
    nothing. The snapshot is now read from either format (legacy heading still
    supported).

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
