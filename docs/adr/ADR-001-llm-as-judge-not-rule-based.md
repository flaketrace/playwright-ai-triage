# ADR-001: LLM-as-judge for ambiguous failures, rule-based for decidable ones

**Status:** Accepted (documents an existing, already-implemented decision)
**Date:** 2026-08-10

## Context

A Playwright failure's error text and stack trace routinely under-determine its cause. The
same surface signature — "TimeoutError waiting for locator", "element(s) not found" — is
produced by a renamed selector, a disabled feature flag, a backend outage the UI never
reports as such, and a genuine product regression that failed to render. `src/prompt.ts`'s
ambiguity rule 1 names this directly: _"TimeoutError waiting for locator" is a hard case —
decide between SELECTOR_DRIFT and FLAKY from the evidence... never by default._

At the same time, a meaningful share of failures are **not** ambiguous at all: a test that
failed and then passed on retry is FLAKY by the run's own outcome, not by inference. A pure
`ECONNREFUSED`/`net::ERR_*` signature is an environment problem regardless of what any model
thinks. The project needed a way to classify every failure into `REAL_BUG` / `FLAKY` /
`SELECTOR_DRIFT` / `ENV_ISSUE` / `UNCLASSIFIED`, self-hosted, cheap enough to run on every
red CI push.

## Decision

Split the problem in two, and route each failure through exactly one path:

1. **Deterministic heuristics first** (`src/heuristics.ts`). A fixed set of rules decides a
   failure locally, with no API call, when the answer is a fact rather than a judgment:
   retried-then-passed (`retryThenPassed`, the run itself proved non-reproducibility), a pure
   network-error signature (`net::ERR_*`, `ECONNREFUSED`, `ETIMEDOUT`, …), the suite's own
   transient-retry wording (`TransientHttpError`, `retryOnTransient`), or explicit
   expired-credential wording. These get confidence 0.85–0.95, because they're stamped as
   deterministic facts about the run itself, not estimated by a model.
2. **An LLM judge for everything heuristics can't decide.** The residual — locator timeouts,
   assertion-value diffs, absence-without-context — goes to a model against a versioned,
   evidence-constrained system prompt (`SYSTEM_PROMPT`, `src/prompt.ts`) that enumerates
   exactly what evidence the payload may carry and what each ambiguity rule permits
   concluding from it.

## Alternatives considered

**Pure rule-based/regex classification, no LLM at all.** This is, in effect, what
`heuristics.ts` already _is_ for the decidable subset — `NETWORK_SIGNATURES`,
`TRANSIENT_RETRY_WORDING`, `EXPIRED_CREDENTIAL_WORDING` are real regex lists doing real work.
Rejected as a _complete_ solution because the hard cases are provably not decidable from text
signature alone. Rule 1 states this outright. A rule-based system given only error text
cannot distinguish a renamed selector from a disabled flag from ordinary slow UI without
reasoning jointly over a DOM snapshot, a diff summary, and retry history — the moment a
judgment call is needed, a rule either overfits to specific strings (breaks on the next
app/framework) or silently defaults to one class. Rules only earn their keep where the
answer is _provably_ decidable from the run's own outcome or an unambiguous text signature —
which is exactly the boundary `heuristics.ts` draws.

**A trained classifier (small model / decision tree) on structured features** (error type,
retry count, DOM-diff features, etc.) instead of a prompted LLM. Rejected mainly on cost of
ownership at this project's actual scale: there was no labeled training set at the start —
building one is precisely the gap the reliability-measurement work (ADR-003, `evals/`) exists
to fill — and a trained classifier still needs the same feature engineering (parsing a DOM
snapshot, diffing a `diffSummary`) that an LLM prompt gets for free via natural-language
reasoning. It also can't produce the prose `why` the taxonomy requires for human trust
without a second, separate explanation-generation step.

**Fully open-ended LLM output** ("what's wrong with this test?") instead of a closed
taxonomy. Rejected: a free-text answer isn't scannable or actionable in a PR comment a human
reads in seconds. See ADR-002 for the taxonomy design itself.

**Route every failure through the LLM, no heuristic pre-pass.** Rejected on cost (see
ADR-005) and on principle: a retried-then-passed failure is FLAKY by definition, not by
estimate — asking a model to "judge" a fact the harness already proved wastes tokens and adds
a real chance of getting an objectively-true fact wrong on a bad model day.

## Consequences

- The majority of easily-decidable failures (flaky-by-retry, pure network signatures) cost
  zero tokens and carry zero model-judgment risk; the LLM budget concentrates on failures
  that actually need reasoning.
- The heuristic pre-pass changes the _effective_ class distribution the model sees on any
  given run — relevant to the imbalance handling in ADR-004.
- Two systems now have to stay conceptually consistent: the regex list in `heuristics.ts` and
  the taxonomy/rules in `prompt.ts`. This is a real, ongoing maintenance cost — evidenced by
  `heuristics.ts`'s `ASSERTION_WORDING` guard, which exists specifically to stop a heuristic
  from misfiring on text the model needs to see (a network phrase quoted _inside_ an
  assertion is content under test, not infrastructure noise).
- The LLM half's correctness is not provable the way a heuristic's is. It requires the whole
  reliability-measurement apparatus (ADR-003) to have any grounded confidence in it at all —
  a cost a purely rule-based system would never have incurred, and a purely LLM-based one
  couldn't avoid.
