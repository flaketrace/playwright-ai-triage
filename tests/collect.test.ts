import type { TestCase, TestResult } from '@playwright/test/reporter';
import { describe, expect, it } from 'vitest';

import { collectFailure } from '../src/collect.js';

function fakeTest(overrides: Partial<Record<string, unknown>> = {}): TestCase {
  return {
    id: 't-1',
    title: 'checkout works',
    location: { file: '/repo/tests/checkout.spec.ts', line: 12, column: 3 },
    outcome: () => 'unexpected',
    results: [],
    ...overrides,
  } as unknown as TestCase;
}

function fakeResult(overrides: Partial<Record<string, unknown>> = {}): TestResult {
  return {
    retry: 0,
    status: 'failed',
    duration: 4200,
    errors: [{ message: 'boom', stack: 'Error: boom\n    at spec.ts:12' }],
    steps: [],
    attachments: [],
    ...overrides,
  } as unknown as TestResult;
}

const opts = { includeDom: false as boolean, diffSummary: undefined as string | undefined };

describe('collectFailure', () => {
  it('builds the basic payload', () => {
    const p = collectFailure(fakeTest(), fakeResult(), opts);
    expect(p).toMatchObject({
      testId: 't-1',
      title: 'checkout works',
      file: '/repo/tests/checkout.spec.ts',
      line: 12,
      errorMessage: 'boom',
      retryThenPassed: false,
      duration: 4200,
    });
  });

  it('truncates error message to 2000 chars and stack to 2000', () => {
    const long = 'x'.repeat(5000);
    const p = collectFailure(
      fakeTest(),
      fakeResult({ errors: [{ message: long, stack: `Error\n${long}` }] }),
      opts,
    );
    expect(p.errorMessage.length).toBeLessThanOrEqual(2000);
    expect(p.stack.length).toBeLessThanOrEqual(2000);
  });

  it('strips node_modules frames from the stack', () => {
    const stack = [
      'Error: nope',
      '    at userCode (/repo/tests/a.spec.ts:5:1)',
      '    at internal (/repo/node_modules/playwright/lib/x.js:1:1)',
    ].join('\n');
    const p = collectFailure(
      fakeTest(),
      fakeResult({ errors: [{ message: 'nope', stack }] }),
      opts,
    );
    expect(p.stack).toContain('userCode');
    expect(p.stack).not.toContain('node_modules');
  });

  it('maps retry history and flags retry-then-passed via outcome()', () => {
    const test = fakeTest({
      outcome: () => 'flaky',
      results: [
        { retry: 0, status: 'failed' },
        { retry: 1, status: 'passed' },
      ],
    });
    const p = collectFailure(test, fakeResult(), opts);
    expect(p.retries).toEqual([
      { attempt: 0, status: 'failed' },
      { attempt: 1, status: 'passed' },
    ]);
    expect(p.retryThenPassed).toBe(true);
  });

  it('extracts the deepest failed step title', () => {
    const steps = [
      {
        title: 'outer step',
        error: { message: 'e' },
        steps: [{ title: 'inner click', error: { message: 'e' }, steps: [] }],
      },
      { title: 'passed step', steps: [] },
    ];
    const p = collectFailure(fakeTest(), fakeResult({ steps }), opts);
    expect(p.failingStep).toBe('inner click');
  });

  it('reads the DOM snippet from the error-context attachment when includeDom is on', () => {
    const md =
      '# Error details\nblah\n# Page snapshot\n- button "Buy" [ref=e7]\n- text "Total: $10"';
    const result = fakeResult({
      attachments: [{ name: 'error-context', contentType: 'text/markdown', body: Buffer.from(md) }],
    });
    const p = collectFailure(fakeTest(), result, { ...opts, includeDom: true });
    expect(p.domSnippet).toContain('button "Buy"');
    expect(p.domSnippet).not.toContain('# Error details');
    expect((p.domSnippet ?? '').length).toBeLessThanOrEqual(1500);
  });

  it('omits domSnippet when attachment is absent or includeDom is off', () => {
    expect(
      collectFailure(fakeTest(), fakeResult(), { ...opts, includeDom: true }).domSnippet,
    ).toBeUndefined();
    const md = '# Page snapshot\n- x';
    const withAttachment = fakeResult({
      attachments: [{ name: 'error-context', contentType: 'text/markdown', body: Buffer.from(md) }],
    });
    expect(collectFailure(fakeTest(), withAttachment, opts).domSnippet).toBeUndefined();
  });

  it('passes through and truncates diffSummary', () => {
    const p = collectFailure(fakeTest(), fakeResult(), { ...opts, diffSummary: 'y'.repeat(2000) });
    expect((p.diffSummary ?? '').length).toBeLessThanOrEqual(1000);
  });

  it('redacts secrets in step titles and test titles (runtime interpolation)', () => {
    const steps = [
      {
        title: 'apiRequest.get with Bearer eyJhbGciOiJIUzI1NiJ9abcdef',
        error: { message: 'e' },
        steps: [],
      },
    ];
    const test = fakeTest({ title: 'login as user sk-ant-api03-abcdefgh12345678' });
    const p = collectFailure(test, fakeResult({ steps }), opts);
    expect(p.failingStep).not.toContain('eyJhbGciOiJIUzI1NiJ9abcdef');
    expect(p.title).not.toContain('sk-ant-api03-abcdefgh12345678');
  });

  it('redacts secrets in error text', () => {
    const p = collectFailure(
      fakeTest(),
      fakeResult({
        errors: [{ message: 'auth failed for sk-ant-api03-abcdefgh12345678', stack: '' }],
      }),
      opts,
    );
    expect(p.errorMessage).not.toContain('sk-ant-api03-abcdefgh12345678');
  });
});
