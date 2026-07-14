# Contributing

Thanks for your interest! The project is in early development; issues and PRs are welcome once
the first functional release lands.

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
