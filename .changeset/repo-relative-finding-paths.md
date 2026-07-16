---
'playwright-ai-triage': minor
---

Finding paths are now repo-relative: file paths in stdout summaries and GitHub PR comments
render relative to Playwright's `rootDir` instead of as absolute CI-runner paths. Files
outside `rootDir` keep the absolute path; separators normalize to `/`.
