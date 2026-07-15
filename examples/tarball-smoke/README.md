# tarball-smoke

A minimal Playwright project that smoke-tests the **packed** `playwright-ai-triage`
artifact — the `.tgz` that `npm pack` produces and that npm publishes — rather than the
source tree. Unlike [`gh-actions-demo`](../gh-actions-demo) (which links the reporter via
`file:../..`), this project has no dependency on the reporter in its `package.json`: CI
installs the freshly built tarball into it, so a passing run proves the published `files`
surface resolves and the bare-string reporter config runs end-to-end.

It uses the exact README snippet — `reporter: [['list'], ['playwright-ai-triage']]` — with
**no `dryRun` and no `ANTHROPIC_API_KEY`**, exercising the graceful-degradation path (failures
reported as "not classified" with a hint). The specs are pure assertions, so no browser
download is required.

```bash
# from the repo root
npm run build
npm pack --pack-destination /tmp
cd examples/tarball-smoke
npm install --no-save /tmp/playwright-ai-triage-*.tgz @playwright/test@^1.61.1
npx playwright test   # exits 1 — the failing test is the point; watch the triage summary
```

Run in CI by the `tarball-smoke` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
