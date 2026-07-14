import { describe, expect, it } from 'vitest';

import { failureFingerprint, normalizeErrorSignature } from '../src/fingerprint.js';

describe('normalizeErrorSignature', () => {
  it('masks number runs including decimals', () => {
    expect(normalizeErrorSignature('Timeout 5000ms exceeded, waited 2.5s')).toBe(
      'Timeout <n>ms exceeded, waited <n>s',
    );
  });

  it('masks ISO timestamps before number masking eats them', () => {
    const n = normalizeErrorSignature('failed at 2026-07-13T21:04:31.123Z retry 3');
    expect(n).toContain('<ts>');
    expect(n).toContain('retry <n>');
    expect(n).not.toMatch(/2026/);
  });

  it('masks UUIDs as a unit', () => {
    const n = normalizeErrorSignature('row 6594b0f5-b236-4341-adcf-c6d02fa0f049 missing');
    expect(n).toBe('row <uuid> missing');
  });

  it('masks long hex runs (ids, shas)', () => {
    expect(normalizeErrorSignature('deployment dpl9f8a7c6b5e4d failed')).toBe(
      'deployment dpl<hex> failed',
    );
  });

  it('pure-digit runs of 8+ mask as <n>, not <hex> (epoch millis must not flip tokens)', () => {
    expect(normalizeErrorSignature('waited 12345678 ms')).toBe('waited <n> ms');
    expect(normalizeErrorSignature('waited 1234567 ms')).toBe('waited <n> ms');
  });

  it('cap is applied after masking: volatile-value length cannot shift the cut point', () => {
    const pad = 'Locator: ' + 'a b '.repeat(58); // ~241 chars of stable head
    const short = normalizeErrorSignature(`${pad} 99 tail`);
    const long = normalizeErrorSignature(`${pad} 123456 tail`);
    expect(short).toBe(long);
  });

  it('masks URL query strings but keeps the path', () => {
    const n = normalizeErrorSignature(
      'goto https://staging.example.dev/reset?token=abc123&t=99 refused',
    );
    expect(n).toContain('https://staging.example.dev/reset?<q>');
    expect(n).not.toContain('abc');
  });

  it('keeps only the head: first 3 non-empty lines, max 240 chars', () => {
    const msg = [
      'Error: expect(locator).toBeVisible() failed',
      '',
      "Locator: locator('#x')",
      'Expected: visible',
      'Call log:',
      '  - retry 84 times',
    ].join('\n');
    const n = normalizeErrorSignature(msg);
    expect(n).toContain('toBeVisible');
    expect(n).toContain('Expected: visible');
    expect(n).not.toContain('Call log');
    expect(normalizeErrorSignature('x'.repeat(1000)).length).toBeLessThanOrEqual(240);
  });

  it('collapses whitespace and trims', () => {
    expect(normalizeErrorSignature('  a\t\tb   c  ')).toBe('a b c');
  });

  it('empty message normalizes to empty string', () => {
    expect(normalizeErrorSignature('')).toBe('');
  });

  it('is idempotent', () => {
    const once = normalizeErrorSignature('Timeout 5000ms at 2026-07-13T00:00:00Z');
    expect(normalizeErrorSignature(once)).toBe(once);
  });
});

describe('failureFingerprint', () => {
  const fp = (testId: string, errorMessage: string) => failureFingerprint({ testId, errorMessage });

  it('returns 12 lowercase hex chars and is deterministic across calls', () => {
    const a = fp('t1', 'Error: boom');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(fp('t1', 'Error: boom')).toBe(a);
  });

  // Stability: real day-1 shapes with volatile parts varied
  it('web-first assertion failure is stable across retry counts and timeouts', () => {
    const v1 =
      'Error: expect(locator).toHaveText(expected) failed\n\nLocator: locator(\'#total\')\nExpected: "$30"\nReceived: "$25"\nTimeout: 1000ms\n\nCall log:\n  - 11 × locator resolved';
    const v2 =
      'Error: expect(locator).toHaveText(expected) failed\n\nLocator: locator(\'#total\')\nExpected: "$30"\nReceived: "$25"\nTimeout: 2000ms\n\nCall log:\n  - 12 × locator resolved';
    expect(fp('cart', v1)).toBe(fp('cart', v2));
  });

  it('locator TimeoutError is stable across durations', () => {
    const v1 =
      "TimeoutError: locator.click: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator('#submit-btn')";
    const v2 =
      "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('#submit-btn')";
    expect(fp('drift', v1)).toBe(fp('drift', v2));
  });

  it('expired-PAT 401 is stable across request ids and hosts with query jitter', () => {
    const v1 =
      'Error: ADO GET failed: 401 Unauthorized | fetch https://dev.azure.com/org/_apis/build?id=123&sig=aa11bb22cc33';
    const v2 =
      'Error: ADO GET failed: 401 Unauthorized | fetch https://dev.azure.com/org/_apis/build?id=456&sig=dd44ee55ff66';
    expect(fp('pat', v1)).toBe(fp('pat', v2));
  });

  // Differentiation
  it('different testId differs even with identical messages', () => {
    expect(fp('a', 'Error: boom')).not.toBe(fp('b', 'Error: boom'));
  });

  it('different matcher differs', () => {
    expect(fp('t', 'Error: expect(locator).toBeVisible() failed')).not.toBe(
      fp('t', 'Error: expect(locator).toHaveText(expected) failed'),
    );
  });

  it('different locator text differs', () => {
    expect(fp('t', "TimeoutError: waiting for locator('#alpha')")).not.toBe(
      fp('t', "TimeoutError: waiting for locator('#omega')"),
    );
  });

  it('structurally different assertion diffs do not collapse', () => {
    expect(fp('t', 'Error: expect(a).toBe(b)\nExpected: "on"\nReceived: "off"')).not.toBe(
      fp('t', 'Error: expect(a).toBe(b)\nExpected: "green"\nReceived: "red"'),
    );
  });

  it('empty message still yields a defined stable fingerprint', () => {
    expect(fp('t', '')).toMatch(/^[0-9a-f]{12}$/);
    expect(fp('t', '')).toBe(fp('t', ''));
  });
});
