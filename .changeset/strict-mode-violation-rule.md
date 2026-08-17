---
"playwright-ai-triage": patch
---

Classifier prompt v007: add ambiguity rule 6 for Playwright "strict mode
violation: locator resolved to N elements" failures. This is a distinct
failure shape from the timeout/absence cases rules 1-3 cover (too many
matches, not too few) and previously had no guidance, so the judge split
unpredictably between REAL_BUG and SELECTOR_DRIFT on the identical failure
across two runs of the same test the same night — a native `<select>`'s
implicit ARIA `combobox` role collided with an intentional autocomplete
input carrying the same role. The rule now defaults this shape to
SELECTOR_DRIFT unless the DOM snippet shows the extra match is itself
erroneous (duplicated content), and the taxonomy/examples name it
explicitly.
