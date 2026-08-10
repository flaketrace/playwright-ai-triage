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
    synthetic: false,
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

  it('redacts a bare hostname that follows a DNS/network-error keyword', () => {
    const a = redactText('getaddrinfo ENOTFOUND payments-api.acme-corp.internal', {});
    expect(a.redacted).toBe('getaddrinfo ENOTFOUND <HOST>');
    expect(a.hits).toContain('HOST');

    const b = redactText('ECONNREFUSED db-prod.acme.cloud:5432', {});
    expect(b.redacted).toBe('ECONNREFUSED <HOST>:5432');
    expect(b.hits).toContain('HOST');
  });

  it('does NOT redact a bare hostname with no network-error keyword context', () => {
    // A known, disclosed gap of the narrower context-gated pass (see the
    // BARE_HOSTNAME comment in evals/anonymize.ts): a hostname mentioned
    // without a preceding DNS/network-error keyword is not caught here.
    // This is the accepted trade-off for eliminating false positives on
    // ordinary code tokens (see the next test) — the tool's printed banner
    // and mandatory dry-run diff review exist precisely to catch this class
    // of miss before --write.
    expect(redactText('host staging.acme.de timed out', {}).redacted).toBe(
      'host staging.acme.de timed out',
    );
  });

  it('redacts an absolute path outside /Users and /home', () => {
    const a = redactText('at /builds/acme/checkout-e2e/tests/pay.spec.ts:9', {});
    expect(a.redacted).toBe('at <PATH>:9');
    expect(a.hits).toContain('PATH');

    const b = redactText('at /var/lib/jenkins/workspace/acme/tests/pay.spec.ts:9', {});
    expect(b.redacted).toBe('at <PATH>:9');
    expect(b.hits).toContain('PATH');

    const c = redactText('at /github/workspace/tests/pay.spec.ts:9', {});
    expect(c.redacted).toBe('at <PATH>:9');
    expect(c.hits).toContain('PATH');
  });

  it('does not redact a version or duration string after a network-error keyword', () => {
    expect(redactText('ETIMEDOUT 30.5s elapsed', {}).redacted).toBe('ETIMEDOUT 30.5s elapsed');
    expect(redactText('ECONNRESET v18.20.4 node', {}).redacted).toBe('ECONNRESET v18.20.4 node');
    expect(redactText('EAI_AGAIN 3.2.1 retry', {}).redacted).toBe('EAI_AGAIN 3.2.1 retry');
  });

  it('does not leak an unlisted path root that contains a listed segment name', () => {
    // A path rooted at something NOT in the known-roots list must stay fully
    // untouched, even if one of ITS segments happens to match a listed root
    // name (e.g. "workspace", "data") — matching starting mid-string there
    // would redact only the tail and silently leave the identifying prefix
    // (/mnt/ci, /codebuild/output/<id>) in place.
    expect(redactText('at /mnt/ci/workspace/tests/pay.spec.ts:9', {}).redacted).toBe(
      'at /mnt/ci/workspace/tests/pay.spec.ts:9',
    );
    expect(
      redactText('at /codebuild/output/src123/workspace/tests/pay.spec.ts:9', {}).redacted,
    ).toBe('at /codebuild/output/src123/workspace/tests/pay.spec.ts:9');
    expect(redactText('at /srv2/data/tests/pay.spec.ts:9', {}).redacted).toBe(
      'at /srv2/data/tests/pay.spec.ts:9',
    );
  });

  it('redacts a file:// URL path (Node ESM stack frames use this form)', () => {
    expect(redactText('at file:///home/runner/work/app/tests/a.spec.ts:3:5', {}).redacted).toBe(
      'at file://<PATH>:3:5',
    );
    expect(
      redactText(
        'Cannot find module file:///builds/acme/checkout/src/util.js imported from file:///builds/acme/checkout/src/main.js',
        {},
      ).redacted,
    ).toBe('Cannot find module file://<PATH> imported from file://<PATH>');
  });

  it('redacts a hostname with a punycode/IDN TLD without garbling it', () => {
    expect(redactText('ENOTFOUND api.acme.xn--p1ai', {}).redacted).toBe('ENOTFOUND <HOST>');
    expect(redactText('ENOTFOUND api.acme.xn--80asehdb', {}).redacted).toBe('ENOTFOUND <HOST>');
  });

  it('does not treat method calls, file references, or short-suffix identifiers as hostnames', () => {
    expect(redactText('Error: page.click: Timeout 30000ms exceeded.', {}).redacted).toBe(
      'Error: page.click: Timeout 30000ms exceeded.',
    );
    expect(redactText('locator.waitFor: Target closed', {}).redacted).toBe(
      'locator.waitFor: Target closed',
    );
    expect(redactText('Received: Object.assign({a: 1})', {}).redacted).toBe(
      'Received: Object.assign({a: 1})',
    );
    expect(redactText('config.ts changed; see playwright.config.ts', {}).redacted).toBe(
      'config.ts changed; see playwright.config.ts',
    );
    expect(redactText('logger.info("starting checkout")', {}).redacted).toBe(
      'logger.info("starting checkout")',
    );
    expect(redactText('TypeError: pattern.test is not a function', {}).redacted).toBe(
      'TypeError: pattern.test is not a function',
    );
  });

  it('does not treat a relative URL route or common container paths as filesystem paths', () => {
    expect(redactText('GET /api/v1/orders returned 500', {}).redacted).toBe(
      'GET /api/v1/orders returned 500',
    );
    expect(redactText('POST /checkout/session/create failed', {}).redacted).toBe(
      'POST /checkout/session/create failed',
    );
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
