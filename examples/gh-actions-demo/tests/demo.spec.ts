import { expect, test } from '@playwright/test';

// One deliberately failing test per failure class. Timeouts are short —
// these exist to feed the reporter, not to wait around.

test('real bug: cart total is computed wrong', async ({ page }) => {
  await page.setContent('<span id="total">$25</span>');
  await expect(page.locator('#total')).toHaveText('$30', { timeout: 1000 });
});

test('selector drift: submit button was renamed', async ({ page }) => {
  await page.setContent('<button>Place order</button>');
  await page.locator('#submit-btn').click({ timeout: 1500 });
});

test('environment issue: backend is unreachable', async ({ page }) => {
  await page.goto('http://127.0.0.1:9', { timeout: 2000 });
});

test('flaky: toast race passes on retry', async ({ page }, testInfo) => {
  await page.setContent('<div id="ok">ready</div>');
  if (testInfo.retry === 0) {
    await expect(page.locator('#missing-toast')).toBeVisible({ timeout: 1000 });
  }
  await expect(page.locator('#ok')).toBeVisible();
});
