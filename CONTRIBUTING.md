# Contributing

Thanks for your interest! Issues and PRs are welcome — check
[docs/ROADMAP.md](docs/ROADMAP.md) for where the project is headed.

## Ground rules

- `npm run gate` (lint + typecheck + tests + build) must pass before any PR.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, …).

Editing `.github/scripts/`? Those are the CI knowledge-sync pipeline's Python
helpers, tested separately: `npm run test:scripts` (needs `pyyaml`). They are out
of `npm run gate` on purpose — this is a Node package.

- Add a changeset (`npx changeset`) for anything user-visible.
- Never commit secrets or real API keys; tests mock the Anthropic SDK.
- Sign off every commit (see below).

## Developer Certificate of Origin

By contributing you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) — that you wrote your
contribution or otherwise have the right to submit it under this project's MIT license. Sign
each commit with `git commit -s`, which adds the `Signed-off-by:` trailer that CI checks on
every pull request.

## Setup

```bash
npm ci
npm run gate
```

## `ADR-NNNN` in source comments

Two decision records are cited by number in source comments (`ADR-0003`, `ADR-0012`). Those records are
the maintainer's private design notes and are not in this repository — there is no `docs/adr/`,
and searching for one is a dead end. Treat each citation as a provenance marker rather than a
link. Most spell out the rule they justify at the citation site; two do not (today
`src/config.ts`'s default-model alias and `src/classify.ts`'s cached price table), and there the
number is the whole of the reference — ask rather than infer. New citations should carry their
rule inline.

## Changing the classifier prompt (`src/prompt.ts`)

Prompt changes are accepted on evidence, not intuition. Run the public smoke eval with your
own key and include its output in the PR:

```bash
ANTHROPIC_API_KEY=sk-... npm run eval:smoke
```

A handful of synthetic fixtures, one Haiku call each — a fraction of a cent. It exits non-zero on
any class-accuracy miss, catching gross regressions; the maintainer additionally runs a larger
private eval (real-world-derived fixtures) before merging prompt changes.

Classification is a draw from a distribution, so one call per fixture is a point estimate with
invisible variance. Set `EVAL_DRAWS=N` (max 25) to classify each fixture N times and grade the
modal class. The table then shows per-fixture agreement, making a fixture whose class flips
between identical calls visible even when the accuracy column looks perfect. Cost scales linearly
with N.

Prefer an odd N. An even one invites ties, and a tied fixture is indeterminate rather than
inaccurate: it is reported ungraded, excluded from the accuracy figure, and exits 4 — distinct
from 1, which means a real class miss.
