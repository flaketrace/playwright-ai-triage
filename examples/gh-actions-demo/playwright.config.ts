import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  retries: 1, // lets the flaky demo pass on retry (FLAKY evidence)
  reporter: [
    ['list'],
    // dryRun: fixture classifications, zero API calls — safe for CI.
    // For real classification, drop dryRun and set ANTHROPIC_API_KEY.
    ['playwright-ai-triage', { dryRun: true }],
  ],
  use: { browserName: 'chromium' },
});
