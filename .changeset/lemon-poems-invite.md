---
'playwright-ai-triage': minor
---

Give the classifier the backend status behind a UI failure.

Payloads now carry `failedRequests` — the status, method and URL of the 4xx/5xx
responses recorded in the failing attempt's trace, deduplicated, capped at 8, with
query strings and URL credentials stripped. Each URL keeps its origin, so internal
hostnames and ports travel with it. The trace file itself is still never
uploaded; README and SECURITY are updated to state exactly this. Playwright's error
text never names the status behind a UI-side failure: a backend 503 surfaces as
"Timeout 60000ms exceeded while waiting on the predicate" and reads exactly like a
race. Until now the prompt's server-error and batch-outage rules could only fire when
a test's own API helper threw the status as text, so the case those rules were written
for was the one they could not see. Requires tracing to be enabled; absent otherwise,
and never fails a run over an unreadable trace.

An over-budget DOM snippet is now truncated from the middle rather than the end. An
aria snapshot is ordered top-of-page first, so keeping the first 1500 characters kept
the banner and nav and dropped the spinner, the "Loading..." text and the error dialog
— the part that says why the test failed. The head is still sampled for page identity
and the elision is marked.

Prompt v006 documents the new field, extends the server-error provenance rule to it,
and adds 429 to the environment statuses.
