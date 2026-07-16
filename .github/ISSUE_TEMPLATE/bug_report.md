---
name: Bug report
about: Something the reporter does wrong — crashes, wrong output, broken comment, misbehaving option
labels: bug
---

## What happened

<!-- What you saw, and what you expected instead. -->

## Reporter output

<!--
Paste the reporter's stdout summary (the block starting with `playwright-ai-triage — …`).
⚠️ Double-check the paste for secrets/URLs you don't want public — redaction is best-effort.
For a misclassification, include the failure's error message and the class + "why" the
reporter produced.
-->

```text

```

## Environment

- `playwright-ai-triage` version:
- `@playwright/test` version:
- Node version:
- CI: <!-- e.g. GitHub Actions / GitLab / local; sharded? -->
- Run mode: <!-- keyed (ANTHROPIC_API_KEY set) or keyless -->
- Outputs enabled: <!-- stdout / github / slack, or auto-detect -->

## Reporter config

```ts
// the reporter tuple from your playwright.config.ts
```

## Reproduction

<!-- Smallest failing spec or steps that trigger it, if you have one. -->
