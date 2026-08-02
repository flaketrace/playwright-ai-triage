---
"playwright-ai-triage": minor
---

Flag stalled attempts inside the retry-then-passed FLAKY verdict.

Payloads now carry `timeoutMs` — the attempt's configured `test.timeout`, alongside the
existing `duration`. Until now `duration` was collected but never used anywhere: not by the
deterministic heuristics, not in the model prompt, not in any rendered output. The retry-then-
passed rule short-circuits to a local FLAKY verdict before any of that data was consulted, so a
test that failed after 45 seconds and one that failed after 16 minutes (a stalled CI runner,
not test-level nondeterminism — Playwright's own timeout mechanism fires at ~timeoutMs, so a
large overrun can only mean the process or runner itself froze around the failure) read
identically: "failed, then passed on retry — deterministic flaky signal", 90% confidence, no
API call.

The verdict's class and confidence are unchanged — retrying was still the right call, and this
is not the hard case those exist to catch. When `duration` is at least 3x `timeoutMs`, `why` now
names the overrun (e.g. "This attempt ran 22.1x its configured timeout (996000ms vs 45000ms)
before failing — not explainable by test-level timing, the process or runner likely stalled
around the failure; treat as an infrastructure risk even though this run self-healed on retry"),
so the summary a human actually reads stops hiding the difference between an ordinary UI race
and a runner that needs investigating. `timeoutMs` is optional and absent payloads behave exactly
as before.

README's job-level-failures note is corrected: its cited example (a From Ashes nightly run where
the job went red from a runner comms drop) did not have "every test passed" and "zero reporter
output" as claimed — the reporter had already triaged 3 real failures earlier in that same run,
verified by re-reading the run's own CI logs. The general point stands (a job's pass/fail status
isn't the same signal as "the reporter had something to say"), the wrong illustration is fixed.
