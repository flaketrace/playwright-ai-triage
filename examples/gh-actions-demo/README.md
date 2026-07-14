# gh-actions-demo

A minimal Playwright project with one deliberately failing test per failure class
(`REAL_BUG`, `SELECTOR_DRIFT`, `ENV_ISSUE`, `FLAKY`). It doubles as the reporter's integration
test: CI runs it with `dryRun: true` — the reporter wiring is exercised end-to-end with zero
API cost (dry-run classifications come from the deterministic heuristics).

```bash
npm install
npx playwright install chromium
npx playwright test   # exits 1 — the failures are the point; watch the triage summary
```

To see real classifications, remove `dryRun: true` from `playwright.config.ts` and set
`ANTHROPIC_API_KEY`.

## GitHub Actions snippet

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write # lets the reporter post/update its PR comment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
