# Contributing

Thanks for your interest! Issues and PRs are welcome — check
[docs/ROADMAP.md](docs/ROADMAP.md) for where the project is headed.

## Ground rules

- `npm run gate` (lint + typecheck + tests + build) must pass before any PR.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, …).
- Add a changeset (`npx changeset`) for anything user-visible.
- Never commit secrets or real API keys; tests mock the Anthropic SDK.

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
