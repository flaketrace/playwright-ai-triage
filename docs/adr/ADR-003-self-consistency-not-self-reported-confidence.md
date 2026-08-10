# ADR-003: Measure reliability via self-consistency, not self-reported confidence

**Status:** Accepted (documents an existing, already-implemented decision)
**Date:** 2026-08-10

## Context

Every classification already carries a model-generated `confidence` field (0..1,
`Classification.confidence`, `src/types.ts`), used today for two narrow purposes: display,
and as a hedging lever inside the prompt's ambiguity rules ("keep confidence at or below
0.5" under specific evidence conditions). The project needed _some_ signal for "is this
judge any good" — both to decide when D6 vote-on-first should trust a majority, and to make
an honest, evidence-backed claim in documentation about how much to trust the tool at all.

## Decision

Use **self-consistency** — N independent draws of the same failure at temperature > 0, and
how often those draws agree with each other — as the reliability signal, never the model's
self-reported `confidence` number. This is computed in two places: `src/reliability.ts`'s
`summarizeDraws`/`classifyWithSelfConsistency` (used by both the `eval` CLI and D6
vote-on-first in production), and graded against human-labeled ground truth via
`src/metrics.ts` (per-class precision/recall/F1, a confusion matrix, and a 95% Wilson-score
confidence interval on every proportion) in `AI_TRIAGE_EVAL_DATASET`/`evals/`.

## Alternatives considered

**Trust the model's self-reported `confidence` directly as a reliability metric** (e.g.
report "average confidence: 0.82" as if it were measured accuracy). This is the cheapest
option — the field already exists, costs zero extra API calls. Rejected specifically because
it's known to be poorly calibrated: a model that says "0.9" is not empirically 90% likely to
be right. Using it as a reliability metric would launder an unverified internal number into
something that _looks_ measured. The field is kept for a narrower, different purpose — a
hedging lever the prompt's ambiguity rules manipulate directly — not repurposed as a
reliability claim.

**Calibrate the self-reported confidence post-hoc** (temperature scaling, Platt scaling)
against a validation set, instead of computing an independent agreement signal. Rejected:
calibration still requires exactly the same labeled ground-truth dataset that measuring
accuracy directly needs (`AI_TRIAGE_EVAL_DATASET` / `evals/`) — so it doesn't remove the "you
need real labels" cost, it adds a recalibration-maintenance burden on top (every prompt or
model version potentially needs recalibrating) for a number that remains a self-report of an
internal model state this project has no way to inspect or guarantee stays stationary across
versions.

**A single draw per failure, treated as final, with no agreement signal at all** — the
default path before self-consistency measurement existed, and still the default path for
ordinary runs today for cost reasons (ADR-005). Rejected as the _only_ option because a point
estimate structurally cannot expose its own variance — `reliability.ts`'s own doc comment
states this plainly: _"a single-draw call reports a point estimate whose variance it cannot
see."_ An unstable case (2 of 3 draws agreeing) is indistinguishable from a rock-solid one in
a single-draw world. Kept as the default for cost, with self-consistency available on demand
(`--draws=N` in the eval CLIs) or auto-enabled selectively (D6 vote-on-first, only for a PR
run's newly-seen failures).

**A different proxy signal** — chain-of-thought length, refusal rate, response latency —
instead of literal draw agreement. Not seriously pursued: none of these have a demonstrated
correlation with correctness for this task, whereas repeated independent sampling and
measuring agreement (self-consistency) is a documented technique for LLM uncertainty
estimation. Adopting an unvalidated proxy would need its own validation study before it could
be trusted for exactly the reason self-reported confidence can't be trusted today — it would
just move the calibration problem, not solve it.

## Consequences

- Disagreement across draws (`summarizeDraws`'s `unstable`/`tied` flags) surfaces even when
  the majority answer happens to be correct — visible in per-fixture agreement reporting
  (`eval/run.ts`, `evals/run.ts`) instead of hidden inside one blended accuracy number.
- Accuracy claims are backed by ground truth plus a confidence interval (Wilson score,
  `src/metrics.ts`), not an unverifiable internal number — this is what makes the README's
  "How much to trust this" section possible to write honestly, including the honest "no real
  cases graded yet" state of the public `evals/` benchmark.
- Measuring self-consistency costs N× the tokens of a single draw wherever it's applied — the
  direct reason it's opt-in/limited rather than universal (D6 fires 3 draws only on a PR
  run's first sighting of a new failure, not every push; the eval CLIs default to 3 draws but
  are run manually, not wired into every CI push). See ADR-005 for the cost side of this
  tradeoff.
- Self-consistency measures the model's confidence _in itself_, not truth — three agreeing
  draws can still all be wrong. `reliability.ts`'s own doc comment is explicit about this:
  disagreement is evidence of ambiguity, agreement is not proof of correctness. It is a
  necessary complement to ground-truth evaluation, never a substitute for it.
