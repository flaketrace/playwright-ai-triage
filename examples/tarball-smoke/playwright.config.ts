import { defineConfig } from '@playwright/test';

// Bare-string reporter form — the exact snippet from the README. This project
// installs playwright-ai-triage from a freshly packed .tgz (see the
// tarball-smoke CI job), so a passing run proves the published artifact
// resolves and runs, not just the source tree.
export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['playwright-ai-triage']],
});
