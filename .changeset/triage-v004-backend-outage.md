---
"playwright-ai-triage": patch
---

Prompt v004 + heuristics: classify backend `5xx`/`409` on setup/seed calls as `ENV_ISSUE`, not `REAL_BUG`.

A dogfood round against a real backend-outage CI run showed the classifier stamping every backend `500`/`503`/`409` as `REAL_BUG` (the taxonomy listed bare "API 4xx/5xx from the app under test" as `REAL_BUG` evidence). On an 11-case eval built from those real failures the shipped prompt scored 46% weighted with ~5 false `REAL_BUG` alarms per run.

- `heuristics.ts`: the suite's own transient-retry wording (`TransientHttpError`, `retryOnTransient`, "HTTP 5xx/409 after N attempts") is now a deterministic local `ENV_ISSUE` verdict — model-independent and free (no tokens). Added `socket hang up` / `upstream connect error` / `disconnect/reset before headers` to the network signatures.
- `prompt.ts` (v004): server errors are `ENV_ISSUE` by default (`REAL_BUG` only for the exact endpoint the test asserts on, tied to the code under test); new batch-wide-outage rule; the absence rule now covers seeded/expected entities.

On the same eval this lifts weighted accuracy to ~97% with 0 dangerous misses and slightly lower cost. The genuine-bug control still classifies as `REAL_BUG` (no over-correction).
