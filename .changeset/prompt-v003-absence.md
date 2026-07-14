---
'playwright-ai-triage': patch
---

Prompt v003: an element's absence is not drift evidence. The classifier no
longer reads a DOM snapshot that merely *lacks* the target element as a
SELECTOR_DRIFT signal — a bare page (or one whose visible elements are unrelated
to the target) is the ambiguous case, equally consistent with a real bug that
failed to render, a disabled flag, or a load failure. Positive rename evidence
(a different element serving the same role/purpose in the snapshot, or a diff
touching that component) remains what a confident SELECTOR_DRIFT call requires.
