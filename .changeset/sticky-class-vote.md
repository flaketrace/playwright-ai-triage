---
'playwright-ai-triage': minor
---

Stable classifications on PRs: persisting failures reuse the class recorded in the reporter's
previous comment (fps:v2 state block now carries class+confidence per fingerprint; v1 blocks
still parse), and first-seen failures are classified by a majority of 3 draws before their
class is frozen. Push/schedule CI runs keep single draws. The sink envelope gains optional
additive `reused` and `draws` provenance fields (schema stays `ai-triage-sink/v1`).
