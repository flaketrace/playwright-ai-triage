---
'playwright-ai-triage': minor
---

Stable classifications on PRs: persisting failures reuse the class recorded in the reporter's
previous comment (fps:v2 state block now carries class+confidence per fingerprint; v1 blocks
still parse), and first-seen failures are classified by a majority of 3 draws before their
class is frozen. Single draws are kept wherever nothing can be frozen: push/schedule CI
runs, and runs whose workflow token cannot read/write PR comments (add
`permissions: pull-requests: write`). A class is only ever stored on a run that voted
on it. The sink envelope gains optional
additive `reused` and `draws` provenance fields (schema stays `ai-triage-sink/v1`).
