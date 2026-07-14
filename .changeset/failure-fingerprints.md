---
'playwright-ai-triage': minor
---

Failure fingerprints (R2): `failureFingerprint()` / `normalizeErrorSignature()` give
every failure a short stable identity — same test + same error shape ⇒ same id, with
volatile parts (numbers, timestamps, UUIDs, hex ids, URL query strings) masked. The
primitive behind cross-run NEW/PERSISTING/RESOLVED delta labeling.
