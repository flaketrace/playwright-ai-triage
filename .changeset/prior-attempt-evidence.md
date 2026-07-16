---
'playwright-ai-triage': minor
---

Prior-attempt evidence in classification payloads: each entry in a failure's
retry history now carries a short error head for earlier attempts whose error
differs from the reported one (ANSI-stripped, secret-redacted, truncated to
300 chars). Previously the classifier saw only the final attempt's error — a
failure whose first two attempts died on backend 500s and whose last attempt
hit a bare timeout looked like "just a timeout" to the model. Identical
repeats are skipped (no signal beyond their status, only token cost), and the
reported attempt's error is never duplicated (it is already the payload's
errorMessage). The README data-flow disclosure is updated accordingly.
