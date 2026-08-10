# ADR-004: Handling imbalanced classes

**Status:** Accepted (documents an existing, already-implemented decision)
**Date:** 2026-08-10

## Context

`FLAKY` vastly outnumbers `REAL_BUG` in real projects — stated repeatedly across the codebase
and docs (README, `src/metrics.ts`'s own doc comment: "The classes are imbalanced (FLAKY
vastly outnumbers REAL_BUG in practice)"). A blended
accuracy figure over an imbalanced dataset can look excellent while the judge is useless at
the rare, high-stakes class — and missing a genuine `REAL_BUG` is a much costlier mistake
than mislabeling an ordinary flake. The concrete failure mode this creates has already
happened once: `CHANGELOG.md`'s 0.3.3 entry documents a shipped prompt that scored 46%
weighted accuracy on an 11-case eval while producing roughly 5 false `REAL_BUG` alarms per
run — a number a blended-only view would not have distinguished from "the judge is
struggling everywhere" versus its actual shape, "the judge is systematically wrong about one
specific evidence pattern."

## Decision

No single fix — several independent mitigations, each addressing a different facet of the
imbalance problem:

1. **Heuristic pre-filtering** (`heuristics.ts`, ADR-001) removes a large share of the
   _dominant_ class — flaky-by-retry, pure `ENV_ISSUE` signatures — from the model's input
   distribution before it ever sees them, changing what the model has to discriminate among,
   at zero LLM-side cost.
2. **Per-class metrics, never blended alone.** `overallAccuracy` is reported _alongside_, not
   instead of, `perClassMetrics` (independent precision/recall/F1 per class) plus a full
   confusion matrix (`src/metrics.ts`). A judge that's "97% accurate" purely by nailing the
   majority `FLAKY` class while missing every `REAL_BUG` is visible in the `REAL_BUG` row,
   not hidden behind the topline number.
3. **`null`, not `0`, for undefined metrics.** A class with zero support or zero predictions
   returns `precision: null`/`recall: null`, never `0` — `0` would silently read as "this
   class performs terribly," which is a meaningfully different and, for a rare class in a
   small eval, more misleading claim than the true meaning: "no data exists to measure this."
4. **Low-support flagging.** A class with fewer than `LOW_SUPPORT_THRESHOLD` (currently 5)
   actual or predicted cases is marked `lowSupport`, not hidden and not silently trusted — the
   number is still computed and shown, but flagged, because a precision/recall figure on
   n=1 is "technically computable and practically meaningless" (the code's own reasoning).
5. **Confidence intervals on every proportion** (Wilson score) rather than bare percentages —
   the rare class structurally has fewer samples and therefore a noisier estimate than the
   common class, and a bare percentage hides that difference entirely.
6. **The golden dataset (`evals/`) is curated for hard boundaries, not sampled to match
   real-world frequency.** It is deliberately _not_ representative — a representative sample
   would be mostly easy `FLAKY` cases and would measure almost nothing about the classes that
   matter most for trust.

## Alternatives considered

**Oversample/undersample training data, or apply class weights during training.** Not
applicable in the literal machine-learning sense — this is prompted inference against a fixed
foundation model, not a model being trained or fine-tuned on this project's data, so there is
no training set to rebalance. The closest analogous lever, the prompt's few-shot examples
(`prompt.ts`'s "Examples" section), is partially imbalance-aware in effect: the rarer,
harder-to-call boundaries (`SELECTOR_DRIFT` vs. `ENV_ISSUE` ambiguity) get three or more
worked examples, while an unambiguous flaky-by-retry case gets one short one, because it
barely needs one.

**A single blended accuracy number with a pass/fail threshold** (e.g. "ship only if accuracy

> 90%"). This is literally what `CHANGELOG.md`'s 0.3.3 entry originally reported as "weighted
> accuracy" for that specific historical eval, and per-class reporting was built precisely to
> supplement it, not replace it with nothing — a blended-only gate can pass while the rare but
> critical class silently fails, which the README explicitly warns about: _"a blended number
> hides a judge that's only good at the common class."_

**Cost-sensitive decision thresholds** — e.g. require higher confidence before committing to
the rare class specifically, since a false `REAL_BUG` alarm and a missed one aren't equally
costly. Partially present in spirit already: the ambiguity rules cap confidence for
`SELECTOR_DRIFT`/`ENV_ISSUE` absent positive evidence, which effectively raises the bar for
those calls, and the server-error provenance rule explicitly favors `ENV_ISSUE` over
`REAL_BUG` absent strong evidence — a real, directional cost-sensitivity choice, just
expressed as a prompt rule rather than a tunable post-hoc threshold. Rejected as an explicit
separate system: the taxonomy's actual asymmetries are already handled case-by-case where
they're best understood — in the rules that know the evidence, not in a generic threshold
layer downstream of them.

**Report only recall for the rare class** (catch every `REAL_BUG`, accept a higher
false-positive rate, since missing a real bug is the worst outcome). Rejected as too narrow:
optimizing recall alone at the cost of precision would flood every PR with false `REAL_BUG`
alarms — precisely the ~5-false-alarms-per-run regression `CHANGELOG.md`'s 0.3.3 entry
documents and fixes. That failure mode is a real, previously-shipped regression, not a
hypothetical, which is why both precision _and_ recall are reported per class.

## Consequences

- A judge that quietly stops working on the rare, high-stakes class is visible in the eval
  report the moment it happens, not discovered months later from an unnoticed miss.
- Heuristic pre-filtering reduces the raw volume of the imbalance problem the LLM has to
  solve at all, for free.
- Per-class reporting with confidence intervals is harder to scan than one blended number —
  the eval CLIs' report format is necessarily denser (a confusion matrix plus five rows of
  precision/recall/F1/CI) than "97% accurate." A real usability cost, paid deliberately for
  honesty.
- The rare classes — `REAL_BUG` especially — will structurally always carry the widest
  confidence intervals in any eval of realistic size, since the imbalance is a property of
  the real world this project reports on, not something the metrics can fix. The golden
  dataset's hard-boundary curation narrows this somewhat by over-representing rare/hard cases
  relative to their true frequency, but can't eliminate the asymmetry — see `evals/README.md`'s
  own disclosed bias section.
