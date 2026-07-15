import { expect, test } from '@playwright/test';

// Pure assertions, no `page` fixture — no browser download needed. One passing
// and one failing test: the failure drives the reporter's graceful-degradation
// path (no ANTHROPIC_API_KEY set → "not classified" + hint), which is exactly
// what the smoke test asserts on.

test('passes', () => {
  expect(1 + 1).toBe(2);
});

test('fails on purpose (feeds the reporter)', () => {
  expect(1 + 1).toBe(3);
});
