import { describe, expect, it } from 'vitest';

import { redactCase, redactText, runAnonymize } from '../evals/anonymize.js';
import type { GoldenCase } from '../evals/schema.js';
import type { FailurePayload } from '../src/types.js';

const rawPayload = (overrides: Partial<FailurePayload> = {}): FailurePayload => ({
  testId: 'x',
  title: 'checkout redirects to https://internal-billing.example-corp.com/pay',
  file: '/Users/alice/work/repo/tests/checkout.spec.ts',
  line: 5,
  errorMessage:
    'Request to https://api.example-corp.com/v1/orders failed: contact ops@example-corp.com',
  stack: 'Bearer sk-live-abcdefghijklmnopqrstuvwx used at 10.0.0.42',
  retries: [{ attempt: 0, status: 'failed' }],
  retryThenPassed: false,
  duration: 900,
  ...overrides,
});

const rawCase = (): GoldenCase =>
  ({
    id: 'EXAMPLE-flaky-as-real-bug-1',
    payload: rawPayload(),
    humanClass: 'REAL_BUG',
    boundaryType: 'flaky-as-real-bug',
    note: 'Looked like a real assertion failure but reporter@example-corp.com confirmed a race.',
  }) as GoldenCase;

describe('redactText', () => {
  it('redacts an email address', () => {
    const { redacted, hits } = redactText('contact ops@example-corp.com now', {});
    expect(redacted).toBe('contact <EMAIL> now');
    expect(hits).toContain('EMAIL');
  });

  it('redacts a URL host', () => {
    const { redacted, hits } = redactText('GET https://api.example-corp.com/v1/orders failed', {});
    expect(redacted).toBe('GET <HOST>/v1/orders failed');
    expect(hits).toContain('HOST');
  });

  it('redacts an IPv4 address', () => {
    const { redacted, hits } = redactText('connected to 10.0.0.42', {});
    expect(redacted).toBe('connected to <HOST>');
    expect(hits).toContain('HOST');
  });

  it('redacts a unix absolute path', () => {
    const { redacted, hits } = redactText('at /Users/alice/work/repo/index.ts:12', {});
    expect(redacted).toBe('at <PATH>:12');
    expect(hits).toContain('PATH');
  });

  it('redacts a windows absolute path', () => {
    const { redacted, hits } = redactText('at C:\\Users\\alice\\work\\repo\\index.ts', {});
    expect(redacted).toBe('at <PATH>');
    expect(hits).toContain('PATH');
  });

  it('redacts a token via the existing src/redact.ts patterns', () => {
    const { redacted, hits } = redactText('Bearer sk-live-abcdefghijklmnopqrstuvwx used', {});
    expect(redacted).not.toContain('sk-live-abcdefghijklmnopqrstuvwx');
    expect(hits).toContain('TOKEN');
  });

  it('leaves ordinary text untouched with no hits', () => {
    const { redacted, hits } = redactText('expect(received).toBe(expected)', {});
    expect(redacted).toBe('expect(received).toBe(expected)');
    expect(hits).toEqual([]);
  });
});

describe('redactCase', () => {
  it('redacts every free-text field and reports a diff per changed field', () => {
    const { case: cleaned, diffs } = redactCase(rawCase(), {});
    expect(cleaned.payload.title).not.toContain('example-corp.com');
    expect(cleaned.payload.file).not.toContain('/Users/alice');
    expect(cleaned.payload.errorMessage).not.toContain('ops@example-corp.com');
    expect(cleaned.payload.stack).not.toContain('sk-live-abcdefghijklmnopqrstuvwx');
    expect(cleaned.note).not.toContain('reporter@example-corp.com');
    const fields = diffs.map((d) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'payload.title',
        'payload.file',
        'payload.errorMessage',
        'payload.stack',
        'note',
      ]),
    );
  });

  it('produces no diff entry for a field with nothing to redact', () => {
    const clean = rawCase();
    clean.payload.failingStep = 'click submit button';
    const { diffs } = redactCase(clean, {});
    expect(diffs.find((d) => d.field === 'payload.failingStep')).toBeUndefined();
  });

  it('redacts domSnippet', () => {
    const withDom = rawCase();
    withDom.payload.domSnippet = '<a href="https://internal.example-corp.com/admin">admin</a>';
    const { case: cleaned, diffs } = redactCase(withDom, {});
    expect(cleaned.payload.domSnippet).not.toContain('example-corp.com');
    expect(diffs.find((d) => d.field === 'payload.domSnippet')).toBeDefined();
  });

  it('redacts hostnames inside failedRequests[].url', () => {
    const withRequests = rawCase();
    withRequests.payload.failedRequests = [
      { status: 503, method: 'GET', url: 'https://api.example-corp.com/v1/search' },
    ];
    const { case: cleaned, diffs } = redactCase(withRequests, {});
    expect(cleaned.payload.failedRequests?.[0]?.url).not.toContain('example-corp.com');
    expect(diffs.find((d) => d.field === 'payload.failedRequests[0].url')).toBeDefined();
  });

  it('leaves failedRequests untouched when there is nothing to redact', () => {
    const withRequests = rawCase();
    withRequests.payload.failedRequests = [{ status: 503, method: 'GET', url: '/relative/path' }];
    const { diffs } = redactCase(withRequests, {});
    expect(diffs.find((d) => d.field === 'payload.failedRequests[0].url')).toBeUndefined();
  });

  it('preserves schema validity of the redacted case', () => {
    const { case: cleaned } = redactCase(rawCase(), {});
    expect(cleaned.id).toBe('EXAMPLE-flaky-as-real-bug-1');
    expect(cleaned.humanClass).toBe('REAL_BUG');
  });

  it('throws when the input does not match the GoldenCase schema', () => {
    expect(() => redactCase({ id: 'bad' }, {})).toThrow();
  });
});

describe('runAnonymize', () => {
  const deps = (overrides: Record<string, unknown> = {}) => ({
    env: {},
    log: () => {},
    errorLog: () => {},
    readFile: () => JSON.stringify(rawCase()),
    writeFile: () => {},
    casesDir: '/tmp/unused',
    ...overrides,
  });

  it('returns 2 with no input path given', async () => {
    const code = await runAnonymize([], deps());
    expect(code).toBe(2);
  });

  it('dry-run (no --write) does not call writeFile', async () => {
    let wrote = false;
    const code = await runAnonymize(
      ['case.json'],
      deps({
        writeFile: () => {
          wrote = true;
        },
      }),
    );
    expect(code).toBe(0);
    expect(wrote).toBe(false);
  });

  it('--write calls writeFile with the redacted case at <casesDir>/<id>.json', async () => {
    let writtenPath = '';
    let writtenContent = '';
    const code = await runAnonymize(
      ['case.json', '--write'],
      deps({
        casesDir: '/out',
        writeFile: (path: string, content: string) => {
          writtenPath = path;
          writtenContent = content;
        },
      }),
    );
    expect(code).toBe(0);
    expect(writtenPath).toBe('/out/EXAMPLE-flaky-as-real-bug-1.json');
    expect(writtenContent).not.toContain('example-corp.com');
  });

  it('returns 2 when the input file is not valid JSON', async () => {
    const code = await runAnonymize(['case.json'], deps({ readFile: () => '{not json' }));
    expect(code).toBe(2);
  });

  it('returns 2 when the input does not match the GoldenCase schema', async () => {
    const code = await runAnonymize(
      ['case.json'],
      deps({ readFile: () => JSON.stringify({ id: 'bad' }) }),
    );
    expect(code).toBe(2);
  });
});
