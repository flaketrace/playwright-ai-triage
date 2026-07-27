import type { FailureClass, FailurePayload } from '../src/types.js';

export interface SmokeFixture {
  name: string;
  payload: FailurePayload;
  /** class-only ground truth — any of these passes outright */
  acceptable: FailureClass[];
  /** classes acceptable only at or below a confidence cap (the prompt's hedging rules) */
  capped?: { class: FailureClass; max: number }[];
}

/**
 * Fully synthetic smoke fixtures. Ground rules:
 * - judgment-shaped only: nothing here may trip a deterministic heuristic
 *   (enforced by tests/eval-smoke.test.ts), or the model is never consulted;
 * - deliberately DISTINCT from the prompt's own few-shot examples — different
 *   error surface forms, locator kinds, and product domains, because a fixture
 *   that mirrors an example tests recall, not classification;
 * - class-only assertions (anyOf); confidence caps encode the prompt's own
 *   hedging rules (on evidence-free absence, SELECTOR_DRIFT and REAL_BUG are
 *   both licensed only at or below 0.5).
 * The full real-world-derived eval lives outside this repo; this set exists so
 * a PR touching src/prompt.ts can be smoke-checked by anyone with a key.
 */
export const SMOKE_FIXTURES: SmokeFixture[] = [
  {
    name: 'real-bug-wrong-count',
    payload: {
      testId: 'real-bug-wrong-count',
      title: 'invoice list shows one row per line item',
      file: 'tests/billing/invoice.spec.ts',
      line: 41,
      errorMessage:
        "expect(page.locator('.invoice-row')).toHaveCount(3) failed\n\nExpected: 3\nReceived: 5",
      stack: '',
      retries: [
        { attempt: 0, status: 'failed' },
        { attempt: 1, status: 'failed' },
      ],
      retryThenPassed: false,
      duration: 3100,
    },
    acceptable: ['REAL_BUG'],
  },
  {
    name: 'drift-renamed-account-menu',
    payload: {
      testId: 'drift-renamed-account-menu',
      title: 'account menu opens from the header',
      file: 'tests/nav/account-menu.spec.ts',
      line: 22,
      errorMessage:
        "Timed out 10000ms waiting for expect(locator).toBeVisible()\n\nLocator: getByTestId('nav-account-menu')\nExpected: visible\nReceived: <element(s) not found>",
      stack: '',
      retries: [
        { attempt: 0, status: 'failed' },
        { attempt: 1, status: 'failed' },
      ],
      retryThenPassed: false,
      domSnippet:
        '- banner:\n  - link "Home"\n  - link "Docs"\n  - button "My account" [ref=e9]\n  - button "Sign out"',
      diffSummary: 'src/components/nav/HeaderNav.tsx | 18 +++++-----',
      duration: 10400,
    },
    acceptable: ['SELECTOR_DRIFT'],
  },
  {
    name: 'env-seed-outage-behind-timeout',
    payload: {
      testId: 'env-seed-outage-behind-timeout',
      title: 'warehouse picker lists the seeded warehouses',
      file: 'tests/inventory/warehouse-picker.spec.ts',
      line: 19,
      errorMessage:
        "TimeoutError: page.waitForSelector('.warehouse-picker') timeout 30000ms exceeded",
      stack: '',
      retries: [
        {
          attempt: 0,
          status: 'failed',
          errorHead:
            'Error: seed request to /api/test-data/warehouses returned 503 Service Unavailable',
        },
        { attempt: 1, status: 'failed' },
      ],
      retryThenPassed: false,
      duration: 31000,
    },
    acceptable: ['ENV_ISSUE'],
  },
  {
    name: 'flag-gated-section-absent',
    payload: {
      testId: 'flag-gated-section-absent',
      title: 'admin reports page offers bulk export',
      file: 'tests/admin/reports-export.spec.ts',
      line: 34,
      errorMessage:
        "Timed out 8000ms waiting for expect(locator).toBeVisible()\n\nLocator: getByRole('region', { name: 'Bulk export' })\nExpected: visible\nReceived: <element(s) not found>",
      stack: '',
      retries: [
        { attempt: 0, status: 'failed' },
        { attempt: 1, status: 'failed' },
      ],
      retryThenPassed: false,
      domSnippet:
        '- heading "Usage reports" [level=1]\n- table:\n  - row "March 2026 12,041 sessions"\n  - row "April 2026 13,377 sessions"\n- button "Refresh data"',
      duration: 8600,
    },
    acceptable: ['ENV_ISSUE', 'UNCLASSIFIED'],
    capped: [
      { class: 'SELECTOR_DRIFT', max: 0.5 },
      { class: 'REAL_BUG', max: 0.5 },
    ],
  },
  {
    name: 'stale-test-fixture-diff',
    payload: {
      testId: 'stale-test-fixture-diff',
      title: 'upgrade CTA links to the current enterprise plan',
      file: 'tests/pricing/upgrade-cta.spec.ts',
      line: 47,
      errorMessage:
        "expect(locator).toHaveAttribute('href', expected) failed\n\nLocator: getByRole('link', { name: 'Upgrade' })\nExpected: '/plans/enterprise-2026'\nReceived: '/plans/enterprise'",
      stack: '',
      retries: [
        { attempt: 0, status: 'failed' },
        { attempt: 1, status: 'failed' },
      ],
      retryThenPassed: false,
      diffSummary: 'tests/fixtures/plan-catalog.ts | 4 ++--',
      duration: 4200,
    },
    acceptable: ['REAL_BUG'],
  },
  {
    name: 'bare-timeout-no-evidence',
    payload: {
      testId: 'bare-timeout-no-evidence',
      title: 'promo banner appears on the home page',
      file: 'tests/home/promo.spec.ts',
      line: 9,
      errorMessage: "TimeoutError: locator('#promo-banner') waiting 15000ms",
      stack: '',
      retries: [{ attempt: 0, status: 'failed' }],
      retryThenPassed: false,
      duration: 15300,
    },
    acceptable: ['FLAKY', 'ENV_ISSUE', 'UNCLASSIFIED'],
    capped: [
      { class: 'SELECTOR_DRIFT', max: 0.5 },
      { class: 'REAL_BUG', max: 0.5 },
    ],
  },
];

/**
 * CANDIDATE — not yet active. Add only alongside an eval run that shows how the
 * current prompt scores it (CONTRIBUTING §"Changing the classifier prompt"); it
 * is written down here rather than merged blind because it may not pass today,
 * and that is the point of it.
 *
 * Gap: a test that navigates to the WRONG STATE has no natural class. The
 * taxonomy covers a renamed element (SELECTOR_DRIFT), a disabled one
 * (ENV_ISSUE) and a broken one (REAL_BUG) — but not "the element is exactly
 * where it should be, and the test is looking at another view of the same
 * component". Rule 5 routes a stale test to REAL_BUG only for content/value
 * mismatches backed by a diff touching the spec; a stale *precondition* produces
 * deterministic absence, which ambiguity rule 2 sends to ENV_ISSUE instead.
 *
 * What makes it different from `flag-gated-section-absent` above — and what a
 * fixture must carry to test this rather than re-test that — is positive
 * evidence in the snapshot that the owning container IS rendered: an expanded
 * dialog/panel holding real content plus a navigation control that leads to the
 * element the test wants. "Disabled in this environment" is refutable from the
 * snapshot alone; the test simply never performed the step in between.
 *
 * Observed in the wild (2026-07): a run classified ENV_ISSUE at 0.60-0.65 on
 * every one of 22 consecutive nights, recommending a feature-flag check, while
 * the real cause was a helper that skipped an onboarding step. The damage was
 * the confidence, not the class — a verdict hedged at <=0.5 reads as the open
 * question it is and sends the reader to the snapshot; 0.65 sends them to the
 * flag config, which is a dead end.
 *
 * Shape: a locator TimeoutError for a control nested inside a container, with a
 * domSnippet in which that container is present, expanded, holding unrelated
 * real content, and offering a back/navigation control.
 *
 * Ground truth is the open question, and it has to be settled before this can
 * be encoded at all: `acceptable` is required and `capped` applies only to
 * classes outside it (grade.ts), so "any class, but ENV_ISSUE only when hedged"
 * is not expressible as written. REAL_BUG is not the obvious answer either —
 * rule 5 scopes the test-side route to content/value mismatches and excludes
 * locator-not-found, which is exactly this shape.
 *
 * The bar that IS defensible today: the snapshot refutes "disabled here", so a
 * confident (>0.5) ENV_ISSUE is wrong. Encoding that means either widening
 * `acceptable` and capping ENV_ISSUE, or extending the harness to cap a class
 * that is also acceptable. Pick one, then add the fixture.
 */
