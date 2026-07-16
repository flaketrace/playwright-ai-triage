# Contributing

Thanks for your interest! Issues and PRs are welcome — check
[docs/ROADMAP.md](docs/ROADMAP.md) for where the project is headed.

## Ground rules

- `npm run gate` (lint + typecheck + tests + build) must pass before any PR.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, …).
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

## Changing the classifier prompt (`src/prompt.ts`)

Prompt changes are accepted on evidence, not intuition. Run the public smoke eval with your
own key and include its output in the PR:

```bash
ANTHROPIC_API_KEY=sk-... npm run eval:smoke
```

A handful of synthetic fixtures, one Haiku call each — costs a fraction of a cent, exits
non-zero on any class-accuracy miss. It catches gross regressions; the maintainer additionally
runs a larger private eval (real-world-derived fixtures) before merging prompt changes.
