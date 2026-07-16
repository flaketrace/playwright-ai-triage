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
