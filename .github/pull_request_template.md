## What & why

<!-- What this changes and the problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] `npm run gate` passes (lint + typecheck + tests + build)
- [ ] Commits follow conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, …)
- [ ] Tests added/updated for the change
- [ ] Changeset added (`npx changeset`) if the change is user-visible
- [ ] No secrets or real API keys in code, tests, or fixtures

### If this touches `src/prompt.ts`

- [ ] Describes the real-world failure case that motivates the change (payload shape + expected
      class), so it can be evaluated — prompt changes are accepted on evidence, not intuition.
      Maintainer runs the classification eval before merge.
