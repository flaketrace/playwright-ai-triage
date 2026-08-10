# Golden dataset — judge accuracy on hard boundaries

`evals/` is a public, curated benchmark for `playwright-ai-triage`'s classifier. Unlike
`eval/` (synthetic smoke fixtures, checks the prompt hasn't obviously regressed) or
`AI_TRIAGE_EVAL_DATASET` (a private, per-user live-labeled dataset), this one is meant to
be shared, reviewed, and grown by anyone — see the main
[README](../README.md#adding-your-own-cases-to-the-eval-dataset) for how those three relate.

## What "golden" means here

Every case in `evals/golden/cases/` sits on a **hard boundary** between two classes — the
kind of failure a judge is likely to get wrong, not the kind that confirms it works. An
easy case (an obvious real bug, an obvious selector rename) measures nothing: any
reasonable classifier gets it right, so it can't tell a good judge from a mediocre one.

Each case is tagged with a `boundaryType`:

| `boundaryType`      | What it tests                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flaky-as-real-bug` | A failure that reads like a deterministic bug (specific wrong value, clean assertion) but is actually a race — retried-and-passed or a nonzero historical failure rate is the tell.                         |
| `drift-as-flaky`    | A failure that reads like ordinary timing flakiness (a timeout) but is actually a renamed/removed selector — a _consistent_ "not found" across retries and zero prior history is the tell.                  |
| `cascading-env`     | A UI-level failure (empty state, wrong count) that is actually caused by a backend/environment problem — a `failedRequests` entry or a spike in historical failure rate across unrelated tests is the tell. |
| `other`             | A hard boundary that doesn't fit the three above. Kept as an escape hatch, not a place to dump ambiguous-but-not-actually-hard cases.                                                                       |

## Coverage

Run `npm run eval:golden` (requires `ANTHROPIC_API_KEY`) to see the current dataset's size,
per-`boundaryType` coverage, and the judge's accuracy/precision/recall/F1/confusion matrix
against it, each figure with a 95% Wilson-score confidence interval. A shrinking spread of
`boundaryType`s over time, or a coverage count concentrating in `other`, means the dataset
is drifting toward easy or unclassifiable cases — check `evals/README.md`'s own table above
against `npm run eval:golden`'s coverage output periodically. Cases whose `id` starts with
`EXAMPLE-` (like the three illustrative cases shipped with this feature) are excluded from
grading by `npm run eval:golden` — they exist to prove the tool works, not to be measured.

## How cases are collected and labeled

Every case declares its provenance via a required `synthetic` field (`evals/schema.ts`).
There are two tracks:

**Real cases** (`synthetic: false`) originate from the maintainer's own Playwright runs.
Raw cases (real error text, stack traces, file paths) never enter this repository directly
— they're anonymized first via `evals/anonymize.ts` (`tsx evals/anonymize.ts
<raw-case.json>`), which prints a diff of every proposed redaction for manual review before
anything is written, and only writes with an explicit `--write` flag. See that file's own
documentation comment for exactly what it does and does not catch. Cases from
client/production systems are held to an additional gate — they are added only with the
data owner's explicit, case-by-case authorization, never inferred as an automatic next step
from having built this tooling. As of this writing, no real cases have cleared that gate
yet — every graded case in this dataset is currently synthetic (see below and `npm run
eval:golden`'s composition line).

**Synthetic-but-realistic cases** (`synthetic: true`) are hand-authored: invented app
scenarios and failure payloads shaped like real Playwright output, written to give the eval
tooling a first real accuracy signal without waiting on real-case data clearance. They are
explicitly not from any real system — see "What's missing / where this dataset is biased"
below for what that means for trusting the numbers.

Labeling is currently **single-rater** for both tracks: whoever authors a case (real or
synthetic) assigns `humanClass` and writes the `note` explaining why.

## Inter-rater agreement

**Not yet measured.** This is a known, open gap, not a number being hidden — a single
labeler's judgment on a boundary case (definitionally, a case chosen because it's easy to
misjudge) has no way to check itself. The intended method, not yet run: a second,
independent labeler classifies a sample of cases blind to the first labeler's `humanClass`
and `note`, and Cohen's κ is computed on the overlap. Until that happens, treat every
`humanClass` in this dataset as one considered opinion, not a verified ground truth.

## What's missing / where this dataset is biased

Being explicit about this is the difference between a benchmark and marketing:

- **Every graded case is currently synthetic.** `npm run eval:golden`'s accuracy numbers
  today reflect the judge's performance on hand-authored, invented-but-realistic scenarios
  — not verified production failures. Synthetic cases are still curated for genuinely hard
  boundaries (see "What 'golden' means here" above), so they're not meaningless, but a
  judge that's well-tuned to one author's idea of what a hard case looks like is not the
  same claim as a judge verified against real-world failure data. Real, NDA-cleared cases
  are the intended next step, not a hypothetical one — see "How cases are collected and
  labeled" above.
- **No inter-rater agreement figure** (see above) — labeling reliability itself is
  unverified.
- **Small-N statistical ceiling.** With on the order of tens of cases, per-class confidence
  intervals (see `npm run eval:golden`'s output) are wide, especially for the least-common
  classes. A single-digit-point accuracy change between runs is well within noise; don't
  read a headline percentage without its interval.
- **Skewed toward the source project's own failure shapes.** These cases come from one
  person's Playwright suites. They are not a random sample of "all possible Playwright
  failures" — a different tech stack, UI framework, or test style will hit boundary shapes
  this dataset doesn't represent at all.
- **English-only error text.** Locator names, assertion messages, and stack traces are all
  English; the judge's behavior on other languages is untested here.
- **No real screenshot content.** `screenshots` records geometry, count, and capture
  timing — never the image itself. Visual-only signals (a layout shift with no error-text
  or DOM signal at all) are not represented.
- **Boundary-only by design, not a representative sample.** This dataset deliberately
  excludes easy cases (see "What golden means here" above) — it will systematically
  understate accuracy relative to a judge's performance on a typical, unfiltered failure
  stream. That's the intended trade — it's the hard cases that matter for trusting the
  judge — but it means this number is not "the judge's real-world accuracy."
