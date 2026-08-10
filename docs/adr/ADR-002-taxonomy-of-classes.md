# ADR-002: A flat five-class taxonomy, not a deeper one

**Status:** Accepted (documents an existing, already-implemented decision)
**Date:** 2026-08-10

## Context

`FailureClass` (`src/types.ts`) is `REAL_BUG | FLAKY | SELECTOR_DRIFT | ENV_ISSUE |
UNCLASSIFIED`. The taxonomy has to be small enough that a human scanning a PR comment
immediately knows what to do next — retry and move on, investigate the app, fix a locator,
escalate to whoever owns infrastructure/config, or read the evidence manually — and precise
enough that those five actions actually map to five distinct root causes worth telling apart.

## Decision

Five classes, four real verdicts plus a required escape hatch:

- `REAL_BUG` — behavior under test diverges from expectation, deterministically, and it isn't
  a backend outage.
- `FLAKY` — not reproducible; timing, race, or third-party transience.
- `SELECTOR_DRIFT` — the element genuinely moved or was renamed; the app itself works.
- `ENV_ISSUE` — infrastructure, configuration, or run-environment — not the app, not the test.
- `UNCLASSIFIED` — only when the evidence is genuinely insufficient to choose. A legitimate
  outcome, not a failure of the classifier.

## Alternatives considered

**Split `REAL_BUG` into "product bug" vs. "test bug"** (the test's own hardcoded expectation
is wrong, not the app). This is a real, observed case — `prompt.ts`'s v005 changelog entry
describes exactly it: a deterministic assertion diff was correctly called `REAL_BUG`, but the
actual root cause was a prior commit baking a wrong assumption into the test's _own_
expected-value helper — not a product regression — discoverable only by checking whether
`diffSummary` touched the test's file or the app's. Rejected as a sixth class; kept as
`REAL_BUG` plus a `suggestedFix` that names the
test's own recently-changed file (rule 5). The immediate action is identical either way — a
red assertion needs someone's judgment — the fork only changes _where_ to look, which
`suggestedFix` already communicates without doubling the taxonomy surface or asking the model
to make a second hard binary call (product-vs-test) stacked on top of the first (is this even
a bug).

**Split `SELECTOR_DRIFT` into RENAMED vs. REMOVED, or split `ENV_ISSUE` into NETWORK / AUTH /
INFRA / CONFIG.** Considered, rejected: the human action is the same at the granularity that
matters for triage (update the locator; escalate to whoever owns infra/config) regardless of
which sub-case it is — and that finer distinction already travels as free text via
`suggestedFix` ("check whether the `awards` feature flag is enabled", a concrete
`getByRole(...)` suggestion) without needing separate classes with their own confidence
calibration and eval support. Splitting also directly worsens the imbalance problem (ADR-004)
— fragmenting an already-minority class five ways leaves some sub-classes with near-zero
real-world support, at which point precision/recall becomes statistically meaningless (see
`LOW_SUPPORT_THRESHOLD` in `src/metrics.ts`, and `evals/README.md`'s explicit small-N
warning).

**A `PERFORMANCE`/`SLOW_TEST` class** for failures caused by unusual runner slowness rather
than an ordinary timing race. Considered given `heuristics.ts`'s stall detection: a duration
3×+ past the configured timeout is flagged with real incident data behind the threshold
("7.7x-22x observed" from a self-hosted runner OS-level stall). Rejected as a class — a
stalled attempt still self-heals on retry, so it _is_ `FLAKY` by outcome, but a human should
treat it as an infrastructure risk rather than shrug it off as ordinary UI timing.
`heuristics.ts` encodes this as an annotation inside `why` (`stallNote`) rather than a new
class, on the same "the action fork doesn't need a taxonomy fork" reasoning as the
product/test split above.

**A `DATA_ISSUE` class** for seeded/fixture-data problems distinct from general
infrastructure failures. Considered, since "a seeded/expected entity (application, account,
department, fixture record) deterministically absent" is a real, named evidence pattern in
the `ENV_ISSUE` row of the taxonomy table. Rejected for the same reason as the drift/env
splits above — the owner who needs to look is the same whether the missing thing is a server,
a flag, or a seed record — and folded into `ENV_ISSUE`.

**No `UNCLASSIFIED` — force a pick among the four real classes.** Rejected explicitly and
early. The prompt states it directly: _"confidence is your honest probability... prefer a
low-confidence honest class over UNCLASSIFIED, but never a confident guess."_ Multiple
ambiguity rules cap confidence at ≤0.5 rather than force a class. A forced guess on genuinely
thin evidence — a bare "element not found" with no DOM snippet, no diff, no retry history,
see the README's own extensive coverage of this — produces a confidently-wrong answer a human
is likely to trust, which is worse than an honest "insufficient evidence." This matters more
because self-reported confidence is already known to be poorly calibrated (ADR-003): a forced
guess would remove the one signal — an admitted "don't know" — that doesn't depend on
calibration at all.

## Consequences

- Five classes map to five distinct, obvious human actions; a PR reader never has to
  interpret nuance the class name doesn't already carry.
- Keeping the taxonomy flat, rather than deepened, keeps every class's eval support
  (`evals/`, per-class precision/recall) statistically meaningful at realistic sample sizes
  instead of fragmenting across sub-classes.
- Real distinctions that matter (test-vs-product, stalled-runner-vs-ordinary-race,
  disabled-flag-vs-missing-server) live in free-text `why`/`suggestedFix`, not in a queryable
  structured field — a user who wants "show me every test-side-bug failure" specifically
  can't filter by class alone.
- `UNCLASSIFIED`, while principled, is an easy target for a model to over-use as a safe
  default under uncertainty. Getting the balance right between honest hedging and useful
  commitment took real iteration: `prompt.ts`'s v003 changelog records a broader
  confidence-cap rewrite that over-hedged (collapsed zero-evidence timeouts to
  `UNCLASSIFIED`) and destabilized previously-correct cases, and was reverted for exactly
  that reason.
