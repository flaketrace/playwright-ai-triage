---
'playwright-ai-triage': patch
---

Two collector-fidelity fixes surfaced by real Playwright output:

- **Strip ANSI escape codes** from error messages and stacks. Playwright
  colourises assertion errors, and those SGR codes were ~20% of the raw error
  text — pure noise sent to the model (~200 wasted tokens per run). They are now
  stripped before redaction, so both the classifier and the secret patterns see
  clean text.
- **Fix `includeDom` on modern Playwright.** Playwright ≳1.53 emits the page
  aria snapshot as a fenced ```yaml block in the error-context attachment rather
  than under a `# Page snapshot` heading, so `includeDom` silently captured
  nothing. The snapshot is now read from either format (legacy heading still
  supported).
