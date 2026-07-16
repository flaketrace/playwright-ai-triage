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

  it('reads the DOM snippet from the current Playwright error-context format (fenced yaml aria block)', () => {
    // Playwright >= ~1.53 embeds the aria snapshot as a ```yaml block instead of
    // a `# Page snapshot` section.
    const md = [
      '# Error details',
      '',
      '```',
      'Error: locator not found',
      '```',
      '',
      '```yaml',
      '- main:',
      '  - heading "Search" [level=1]',
      '  - button "Buy"',
      '```',
      '',
      '# Test source',
      '```ts',
      'await expect(x).toBeVisible();',
      '```',
    ].join('\n');
    const result = fakeResult({
      attachments: [{ name: 'error-context', contentType: 'text/markdown', body: Buffer.from(md) }],
    });
    const p = collectFailure(fakeTest(), result, { ...opts, includeDom: true });
    expect(p.domSnippet).toContain('heading "Search"');
    expect(p.domSnippet).toContain('button "Buy"');
    expect(p.domSnippet).not.toContain('Error: locator not found'); // not the error block
    expect(p.domSnippet).not.toContain('toBeVisible'); // not the test-source block
  });

  it('strips ANSI escape codes from error text and stack (real Playwright output is colourised)', () => {
    const ESC = String.fromCharCode(27);
    const colourised = `Error: ${ESC}[2mexpect(${ESC}[22m${ESC}[31mlocator${ESC}[39m${ESC}[2m).${ESC}[22mtoBeVisible failed`;
    const p = collectFailure(
      fakeTest(),
      fakeResult({ errors: [{ message: colourised, stack: `${colourised}\n    at a.spec.ts:1` }] }),
      opts,
    );
    expect(p.errorMessage).not.toContain(ESC);
    expect(p.errorMessage).toBe('Error: expect(locator).toBeVisible failed');
    expect(p.stack).not.toContain(ESC);
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

  it('still redacts a secret whose token is interleaved with ANSI codes (strip runs before redact)', () => {
    const ESC = String.fromCharCode(27);
    const p = collectFailure(
      fakeTest(),
      fakeResult({
        errors: [
          {
            message: `auth failed for sk-ant-api03-${ESC}[2mabcdefgh12345678${ESC}[22m`,
            stack: '',
          },
        ],
      }),
      opts,
    );
    expect(p.errorMessage).not.toContain('sk-ant-api03-abcdefgh12345678');
    expect(p.errorMessage).not.toContain('sk-ant-api03');
  });

  it('carries a redacted error head for prior attempts, but not for the reported one', () => {
    const test = fakeTest({
      results: [
        {
          retry: 0,
          status: 'failed',
          errors: [
            {
              message:
                'Failed to seed: 500 Internal Server Error (token sk-ant-api03-abcdefgh12345678)',
            },
          ],
        },
        {
          retry: 1,
          status: 'failed',
          errors: [{ message: "TimeoutError: locator('#total') waiting 30000ms" }],
        },
      ],
    });
    const finalResult = fakeResult({
      retry: 1,
      errors: [{ message: "TimeoutError: locator('#total') waiting 30000ms" }],
    });
    const p = collectFailure(test, finalResult, opts);
    expect(p.retries[0]?.errorHead).toContain('500 Internal Server Error');
    expect(p.retries[0]?.errorHead).not.toContain('sk-ant-api03-abcdefgh12345678');
    // the reported attempt's error is already the payload's errorMessage — never duplicated
    expect(p.retries[1]?.errorHead).toBeUndefined();
  });

  it('strips ANSI from prior-attempt error heads and omits them for attempts without errors', () => {
    const ESC = String.fromCharCode(27);
    // realistic flaky-after-two-failures shape: the reporter always reports the
    // last FAILED attempt (retry 1 here), never the passed one
    const test = fakeTest({
      outcome: () => 'flaky',
      results: [
        {
          retry: 0,
          status: 'failed',
          errors: [{ message: `${ESC}[31mError: seed exploded${ESC}[39m` }],
        },
        { retry: 1, status: 'failed', errors: [{ message: 'boom' }] },
        { retry: 2, status: 'passed' },
      ],
    });
    const p = collectFailure(test, fakeResult({ retry: 1 }), opts);
    expect(p.retries[0]?.errorHead).toBe('Error: seed exploded');
    expect(p.retries[1]?.errorHead).toBeUndefined(); // the reported attempt
    expect(p.retries[2]?.errorHead).toBeUndefined(); // passed, no errors
  });

  it('omits the errorHead when a prior attempt failed identically to the reported one', () => {
    const test = fakeTest({
      results: [
        { retry: 0, status: 'failed', errors: [{ message: 'boom' }] },
        { retry: 1, status: 'failed', errors: [{ message: 'boom' }] },
      ],
    });
    const p = collectFailure(test, fakeResult({ retry: 1 }), opts);
    // an identical repeat carries no signal beyond its status — don't spend tokens on it
    expect(p.retries[0]?.errorHead).toBeUndefined();
  });

  it('dedupes repeats that differ only by ANSI codes or secret values', () => {
    const ESC = String.fromCharCode(27);
    const test = fakeTest({
      results: [
        {
          retry: 0,
          status: 'failed',
          errors: [
            { message: `${ESC}[31mauth failed for sk-ant-api03-aaaaaaaa11111111${ESC}[39m` },
          ],
        },
        {
          retry: 1,
          status: 'failed',
          errors: [{ message: 'auth failed for sk-ant-api03-bbbbbbbb22222222' }],
        },
      ],
    });
    const p = collectFailure(
      test,
      fakeResult({
        retry: 1,
        errors: [{ message: 'auth failed for sk-ant-api03-bbbbbbbb22222222' }],
      }),
      opts,
    );
    // after stripping/redaction both attempts read identically — still a repeat
    expect(p.retries[0]?.errorHead).toBeUndefined();
  });

  it('truncates prior-attempt error heads to 300 chars', () => {
    const test = fakeTest({
      results: [
        { retry: 0, status: 'failed', errors: [{ message: 'z'.repeat(5000) }] },
        { retry: 1, status: 'failed', errors: [{ message: 'boom' }] },
      ],
    });
    const p = collectFailure(test, fakeResult({ retry: 1 }), opts);
    expect(p.retries[0]?.errorHead).toBeDefined();
    expect((p.retries[0]?.errorHead ?? '').length).toBeLessThanOrEqual(300);
    // head-first truncation: the original text's head survives, marked with an ellipsis
    expect(p.retries[0]?.errorHead).toMatch(/^z+…$/);
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

describe('repo-relative file paths', () => {
  it('renders the file relative to rootDir', () => {
    const p = collectFailure(fakeTest(), fakeResult(), { ...opts, rootDir: '/repo' });
    expect(p.file).toBe('tests/checkout.spec.ts');
  });

  it('keeps the absolute path when the file is outside rootDir', () => {
    const p = collectFailure(fakeTest(), fakeResult(), { ...opts, rootDir: '/elsewhere/project' });
    expect(p.file).toBe('/repo/tests/checkout.spec.ts');
  });

  it('keeps the absolute path when no rootDir is provided (back-compat)', () => {
    const p = collectFailure(fakeTest(), fakeResult(), opts);
    expect(p.file).toBe('/repo/tests/checkout.spec.ts');
  });

  it('handles a trailing-slash rootDir', () => {
    const p = collectFailure(fakeTest(), fakeResult(), { ...opts, rootDir: '/repo/' });
    expect(p.file).toBe('tests/checkout.spec.ts');
  });

  it('does not treat a sibling directory sharing the path prefix as inside rootDir', () => {
    const p = collectFailure(fakeTest(), fakeResult(), { ...opts, rootDir: '/repo/tests-archive' });
    expect(p.file).toBe('/repo/tests/checkout.spec.ts');
  });

  it('keeps the absolute path when the file lives in a sibling dir extending rootDir as a prefix', () => {
    const t = fakeTest({
      location: { file: '/repo/tests-archive/old.spec.ts', line: 8, column: 1 },
    });
    const p = collectFailure(t, fakeResult(), { ...opts, rootDir: '/repo/tests' });
    expect(p.file).toBe('/repo/tests-archive/old.spec.ts');
  });

  it('relativizes a directory whose name starts with dots', () => {
    const t = fakeTest({ location: { file: '/repo/..data/x.spec.ts', line: 3, column: 1 } });
    const p = collectFailure(t, fakeResult(), { ...opts, rootDir: '/repo' });
    expect(p.file).toBe('..data/x.spec.ts');
  });
});
