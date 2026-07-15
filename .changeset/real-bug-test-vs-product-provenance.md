---
"playwright-ai-triage": patch
---

Classifier prompt v005: REAL_BUG now distinguishes test-side vs product-side
cause when diffSummary is provided. Previously a deterministic assertion-diff
was always classified REAL_BUG with no suggestedFix, leaving the reader to
work out unaided whether the app regressed or the test's own hardcoded
expected value was what changed. New rule 5: when the diff is confined to the
failing test's own spec file or a shared test helper (a formatter, fixture
builder, constant) rather than app/product source, the classifier now says so
in `why` and gives REAL_BUG a `suggestedFix` pointing at verifying that
recent test-side change against live behavior first. Found via a real dogfood
case: a Playwright suite's scheduled-update banner assertion expected a
long-form date string a prior test-only commit had introduced, while the app
still rendered its original short-form date — REAL_BUG was technically
correct but gave no hint the fix belonged in the test, not the app.
