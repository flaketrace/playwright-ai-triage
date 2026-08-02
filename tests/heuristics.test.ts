import { describe, expect, it } from 'vitest';

import { heuristicFor } from '../src/heuristics.js';

const payload = (errorMessage: string, retryThenPassed = false, stack = '') => ({
  errorMessage,
  stack,
  retryThenPassed,
});

describe('heuristicFor', () => {
  it('retry-then-passed wins even over network noise: local FLAKY verdict', () => {
    const r = heuristicFor(payload('net::ERR_CONNECTION_REFUSED', true));
    expect(r.prior).toBe('FLAKY');
    expect(r.verdict).toMatchObject({ class: 'FLAKY', confidence: 0.9 });
    expect(r.verdict?.why).toContain('passed on retry');
  });

  it('retry-then-passed still classifies FLAKY, but flags a stalled attempt in why', () => {
    // real incident: TimeoutError: page.goto: Timeout 30000ms exceeded, duration
    // 996000ms (16.6m) against a 45000ms test timeout — the process/runner froze
    // mid-test (macOS Power Nap), not a normal race.
    const r = heuristicFor({
      errorMessage: 'TimeoutError: page.goto: Timeout 30000ms exceeded',
      stack: '',
      retryThenPassed: true,
      duration: 996_000,
      timeoutMs: 45_000,
    });
    expect(r.verdict).toMatchObject({ class: 'FLAKY', confidence: 0.9 });
    expect(r.verdict?.why).toContain('passed on retry');
    expect(r.verdict?.why).toContain('22.1x its configured timeout');
    expect(r.verdict?.why).toContain('infrastructure risk');
  });

  it('retry-then-passed with an ordinary duration stays the plain FLAKY why (no stall note)', () => {
    const r = heuristicFor({
      errorMessage: 'TimeoutError: waiting for locator(".toast-success")',
      stack: '',
      retryThenPassed: true,
      duration: 1_200,
      timeoutMs: 30_000,
    });
    expect(r.verdict?.why).toBe(
      'failed, then passed on retry — deterministic flaky signal; classified locally without an API call',
    );
  });

  it('retry-then-passed without duration/timeoutMs (older payload shape) is unaffected', () => {
    const r = heuristicFor(payload('TimeoutError: waiting for locator(".toast-success")', true));
    expect(r.verdict?.why).toBe(
      'failed, then passed on retry — deterministic flaky signal; classified locally without an API call',
    );
  });

  it('just under the stall ratio (2.9x) does not trigger', () => {
    const r = heuristicFor({
      errorMessage: 'TimeoutError',
      stack: '',
      retryThenPassed: true,
      duration: 87_000,
      timeoutMs: 30_000,
    });
    expect(r.verdict?.why).not.toContain('infrastructure risk');
  });

  it('exactly at the stall ratio (3.0x) does trigger — the threshold is inclusive', () => {
    const r = heuristicFor({
      errorMessage: 'TimeoutError',
      stack: '',
      retryThenPassed: true,
      duration: 90_000,
      timeoutMs: 30_000,
    });
    expect(r.verdict?.why).toContain('3.0x its configured timeout');
  });

  it.each(['net::ERR_NAME_NOT_RESOLVED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])(
    'pure network signature %s => local ENV_ISSUE verdict',
    (sig) => {
      const r = heuristicFor(payload(`request failed: ${sig}`));
      expect(r.prior).toBe('ENV_ISSUE');
      expect(r.verdict).toMatchObject({ class: 'ENV_ISSUE', confidence: 0.95 });
    },
  );

  it('network signature mixed with a locator timeout => ENV prior but NO local verdict', () => {
    const r = heuristicFor(
      payload('TimeoutError: waiting for locator("#cart") — page.goto: net::ERR_CONNECTION_RESET'),
    );
    expect(r.prior).toBe('ENV_ISSUE');
    expect(r.verdict).toBeUndefined();
  });

  it.each([
    'Test timeout of 30000ms exceeded. — page.goto: net::ERR_CONNECTION_RESET',
    'Timed out 5000ms waiting for expect(locator).toBeVisible() after ECONNRESET',
  ])('real Playwright timeout phrasing "%s" mixed with network => NO local verdict', (msg) => {
    const r = heuristicFor(payload(msg));
    expect(r.prior).toBe('ENV_ISSUE');
    expect(r.verdict).toBeUndefined();
  });

  it('ENOTFOUND (DNS) counts as a network signature', () => {
    const r = heuristicFor(payload('page.goto: getaddrinfo ENOTFOUND staging.example.com'));
    expect(r.prior).toBe('ENV_ISSUE');
    expect(r.verdict).toMatchObject({ class: 'ENV_ISSUE' });
  });

  it.each([
    'ADO GET failed: 401 Unauthorized | Access Denied: The Personal Access Token used has expired.',
    'request rejected: your API key expired on 2026-06-01',
    'TLS handshake failed: certificate has expired',
  ])('explicit expired-credential wording "%s" => local ENV_ISSUE verdict', (msg) => {
    const r = heuristicFor(payload(msg));
    expect(r.prior).toBe('ENV_ISSUE');
    expect(r.verdict).toMatchObject({ class: 'ENV_ISSUE', confidence: 0.9 });
    expect(r.verdict?.why).toContain('expired-credential');
  });

  it('generic 401 without expiry wording is NOT script-decidable — reaches the model', () => {
    expect(heuristicFor(payload('API request failed: 401 Unauthorized'))).toEqual({});
  });

  it.each([
    'Timed out 5000ms waiting for expect(locator).toHaveText("Your Personal Access Token has expired")',
    'expect(received).toBe(expected)\nExpected: "Your API key expired"\nReceived: ""',
  ])('expiry wording inside assertion/timeout "%s" reaches the model (no verdict)', (msg) => {
    expect(heuristicFor(payload(msg)).verdict).toBeUndefined();
  });

  it('"expired" far from any credential noun does not trigger the verdict', () => {
    expect(heuristicFor(payload('the coupon expired yesterday, expected banner to show'))).toEqual(
      {},
    );
  });

  it('locator timeout alone is the hard case: no prior, no verdict', () => {
    expect(
      heuristicFor(
        payload(
          'TimeoutError: locator.click: Timeout 30000ms exceeded waiting for locator("#buy")',
        ),
      ),
    ).toEqual({});
  });

  it('plain assertion failure: no prior, no verdict', () => {
    expect(heuristicFor(payload('expect(received).toBe(expected)'))).toEqual({});
  });

  it.each([
    'TransientHttpError: Department catalog refresh failed: 500 Internal Server Error',
    'Error: PUT app-config version-configurations/2026: HTTP 500 after 4 attempts',
    'Error: GET billing-accounts/import: HTTP 409 after 4 attempts',
    'failed inside retryOnTransientRequest after exhausting the budget',
  ])('suite transient-retry wording "%s" => local ENV_ISSUE verdict', (msg) => {
    const r = heuristicFor(payload(msg));
    expect(r.prior).toBe('ENV_ISSUE');
    expect(r.verdict).toMatchObject({ class: 'ENV_ISSUE', confidence: 0.85 });
    expect(r.verdict?.why).toContain('transient');
  });

  it.each(['socket hang up', 'upstream connect error', 'disconnect/reset before headers'])(
    'transport-drop signature "%s" => local ENV_ISSUE verdict',
    (sig) => {
      const r = heuristicFor(payload(`apiRequestContext.get: ${sig}`));
      expect(r.prior).toBe('ENV_ISSUE');
      expect(r.verdict).toMatchObject({ class: 'ENV_ISSUE', confidence: 0.95 });
    },
  );

  it('a transport-drop phrase quoted inside an assertion reaches the model (prior only, no verdict)', () => {
    const r = heuristicFor(
      payload("expect(page.getByRole('alert')).toHaveText('upstream connect error')"),
    );
    expect(r.prior).toBe('ENV_ISSUE');
    expect(r.verdict).toBeUndefined();
  });

  it('a 5xx the test ASSERTS on (assertion wording present) reaches the model, no verdict', () => {
    const r = heuristicFor(
      payload('expect(response.status()).toBe(200)\nReceived: 500 — TransientHttpError body'),
    );
    expect(r.verdict).toBeUndefined();
  });

  it('a bare 5xx without transient-retry wrapper is left to the model (no verdict)', () => {
    expect(
      heuristicFor(payload('Failed to create application: 500 Internal Server Error')),
    ).toEqual({});
  });
});
