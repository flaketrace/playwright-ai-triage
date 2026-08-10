# ADR-005: Token cost vs. accuracy — where the line is drawn

**Status:** Accepted (documents an existing, already-implemented decision)
**Date:** 2026-08-10

## Context

This is a self-hosted tool by design (README) — the user pays their own Anthropic usage, and
cost is printed per run. Every accuracy-improving lever available — a bigger model, more
draws per failure, richer evidence fields, self-consistency — costs real money, and costs it
on every red CI push, at whatever scale the adopting team runs at. "Always use the most
capable option" is not a neutral default here; it's an unbounded, recurring cost decision
made on someone else's behalf. The project needed explicit, considered tradeoffs instead.

## Decision

Several concrete, independently-tunable cost levers, chosen deliberately rather than left to
default to "maximum":

1. **Model default: Haiku, not Sonnet.** `config.ts` defaults `model` to the Haiku alias.
   `classify.ts`'s `PRICING` table: Haiku is $1/$5 per 1M input/output tokens vs. Sonnet's
   $3/$15 — Sonnet costs 3× on both sides. `model` stays user-configurable so a team that
   wants to pay for higher accuracy can, explicitly, rather than the tool imposing that
   choice on everyone.
2. **Heuristics-first (ADR-001/ADR-004) is the highest-leverage cost lever in the system.** A
   heuristically-decided failure costs exactly zero tokens, not "fewer" — and these are
   precisely the cases (flaky-by-retry, pure network signature) where the model would add
   cost without adding information, since the answer is already deterministically known.
3. **Sticky reuse (R2).** A persisting failure — same fingerprint as the prior run's recorded
   verdict — is never re-classified; the verdict is reused for free. Justified on more than
   cost: re-spending tokens on an unchanged failure would also reintroduce classification
   noise for zero benefit, since "the classification is a draw from a distribution... redrawing
   a known failure risks flipping its class for no reason" (the code's own reasoning).
4. **D6 vote-on-first, not vote-always.** Three independent draws (`VOTE_DRAWS = 3`) run only
   when the caller enables voting — the reporter turns this on for a PR run's _newly-seen_
   failures, since those get frozen into the sticky PR block and are worth getting right
   once. Roughly triples cost on first sighting, repaid by R2 sticky reuse on every
   subsequent push at zero additional cost. Three, not two or four, specifically avoids ties
   — a tied self-consistency result is `INDETERMINATE` (`summarizeDraws`) and can't be graded
   or acted on, so an even draw count would spend API calls on results the system then has to
   discard.
5. **`maxFailures` cap (default 25), with honest overflow, not silent truncation.** An entry
   beyond the cap is recorded `UNCLASSIFIED` with `why: "beyond the maxFailures budget cap"`
   — bounding worst-case cost on a catastrophically broken run (hundreds of simultaneous
   failures) without ever hiding that a failure went unclassified.
6. **`BATCH_SIZE = 10`.** Failures are batched into one API call per 10 rather than one call
   per failure, amortizing the fixed cost of the system prompt — a genuinely large payload:
   the full taxonomy, five ambiguity rules, seven worked examples — across multiple failures
   per call. At low failure counts, re-sending that prompt text per single failure would be
   the dominant cost.
7. **Evidence fields are opt-in, not default-on** — `includeDom`, `GIT_DIFF_SUMMARY`, and
   trace-derived `failedRequests` each add real, measurable per-failure token cost (a DOM
   snapshot in particular can be large), and each is scoped narrowly to what the ambiguity
   rules actually need — not a blanket "send everything" default.

## Alternatives considered

**Always use the most capable/expensive model available**, on the reasoning that correctness
matters more than cost. Rejected as the _default_ (not rejected outright — it remains
available via configuration): a cost surprise on day one is a real adoption-killer for a
self-hosted tool meant to run on every red push across potentially many repos and teams. More
importantly, the actual evidence doesn't support model tier as the dominant lever for the
accuracy problems this project has actually hit — `CHANGELOG.md`'s 0.3.3 entry shows a
46%→~97% accuracy jump on the same model, driven entirely by a prompt/taxonomy fix (server
errors on setup calls being misread as `REAL_BUG`). A bigger model would not have fixed a
taxonomy bug the taxonomy fix did.

**Vote on every classification, not just first sighting**, for maximum reliability
everywhere. Rejected on multiplicative cost: 3× every classification, every push, forever,
versus 3× once per genuinely _new_ failure with free reuse afterward. The marginal
reliability gain of re-voting on an already-frozen, unchanged failure is close to zero (the
same reasoning behind R2's reuse decision above), while the cost is not.

**No cap on failures classified per run.** Rejected: an uncapped worst case — a genuinely
broken environment failing hundreds of tests identically — would either blow up cost
unpredictably or force some form of silent dropping. The chosen design (hard cap plus honest
per-entry `why` on overflow) bounds cost predictably while staying transparent about the
tradeoff instead of hiding it.

**Send full evidence (DOM snapshot, diff summary, trace data) on every failure by default**,
since the README's own "How much evidence you give it" section documents that more evidence
measurably resolves ambiguity. Rejected as a default given the exact tension the README names
directly: these fields are expensive precisely _because_ they're the ones that separate the
ambiguous classes — defaulting them on would tax every run, including the majority heuristics
already resolve for free or the model gets right with base evidence alone, for the benefit of
only the hard-boundary minority that actually needs them. Opt-in shifts that cost decision to
the user, who knows their own accuracy/cost tolerance better than the tool does.

**Fuzzy/similarity-based reuse across different-but-similar failures**, not just exact
fingerprint matches, via embeddings or some other similarity measure. Not pursued: R2's
sticky reuse is deliberately scoped to an _exact_ fingerprint match because that's what makes
it provably safe — nothing about the failure changed, so re-classifying adds noise, not
signal. Fuzzy similarity-based reuse would reintroduce exactly the classification-drift risk
R2 exists to avoid, for a cost saving that heuristics and batching already capture more
safely.

## Consequences

- The common-case cost profile — heuristic-decided `FLAKY`/`ENV_ISSUE` at zero tokens,
  persisting failures reused at zero tokens, one batched call per 10 new ambiguous failures —
  means a typical PR with a handful of failures costs a small fraction of a cent, and that
  cost is printed per run so the tradeoff stays visible rather than hidden.
- Every lever (model, draw count, evidence fields, `maxFailures`) is independently
  user-configurable, so a team with different cost/accuracy priorities than the defaults
  isn't locked into this project's specific choice.
- The cost/accuracy curve is uneven across evidence dimensions by design: a run that never
  opts into `includeDom`/`diffSummary`/tracing will structurally hedge more (more
  `UNCLASSIFIED`, lower confidence) on exactly the hard cases those fields exist to resolve.
  That under-evidenced degradation is easy to mistake for "the judge doesn't work" rather
  than "the judge wasn't given what it needs" — which is why the README says explicitly to
  check what a hedged verdict was given before doubting the classifier.
- D6's vote-on-first plus R2's sticky reuse together mean a given failure's classification
  quality is effectively locked in at first sighting. If the prompt improves later, a
  persisting failure keeps its _old_ verdict via sticky reuse rather than benefiting from the
  improvement until its fingerprint changes or the sticky state resets — a real staleness
  cost, traded deliberately for the reuse savings.
