import { describe, expect, it } from 'vitest';

import type { ClassifiedFailure } from '../src/classify.js';
import { renderAllClearSummary, renderMarkdownSummary } from '../src/render/markdown.js';
import type { Classification, FailurePayload } from '../src/types.js';

const payload = (id: string, overrides: Partial<FailurePayload> = {}): FailurePayload => ({
  testId: id,
  title: `test ${id}`,
  file: `/repo/tests/${id}.spec.ts`,
  line: 7,
  errorMessage: 'boom',
  stack: '',
  retries: [{ attempt: 0, status: 'failed' }],
  retryThenPassed: false,
  duration: 100,
  ...overrides,
});

const cls = (
  id: string,
  klass: Classification['class'],
  extra: Partial<Classification> = {},
  p: Partial<FailurePayload> = {},
): ClassifiedFailure => ({
  payload: payload(id, p),
  classification: { class: klass, confidence: 0.9, why: `because ${id}`, ...extra },
});

const baseCtx = {
  model: 'claude-haiku-4-5',
  costUsd: 0.0123,
  notes: [] as string[],
  shard: null as { current: number; total: number } | null,
};

describe('renderMarkdownSummary', () => {
  it('renders the grouped summary (golden)', () => {
    const md = renderMarkdownSummary(
      [
        cls('a', 'REAL_BUG'),
        cls('b', 'SELECTOR_DRIFT', { suggestedFix: "getByRole('button', { name: 'Buy' })" }),
        cls('c', 'FLAKY'),
      ],
      baseCtx,
    );
    expect(md).toMatchSnapshot();
  });

  it('always carries the growth-loop footer', () => {
    const md = renderMarkdownSummary([cls('a', 'REAL_BUG')], baseCtx);
    expect(md).toContain('Triaged by [playwright-ai-triage]');
    expect(md).toContain('claude-haiku-4-5');
    expect(md).toContain('$0.0123');
  });

  it('marks sharded runs in the header', () => {
    const md = renderMarkdownSummary([cls('a', 'REAL_BUG')], {
      ...baseCtx,
      shard: { current: 2, total: 5 },
    });
    expect(md).toContain('shard 2/5');
  });

  it('groups by project when a project map is provided (golden)', () => {
    const md = renderMarkdownSummary([cls('a', 'REAL_BUG'), cls('b', 'FLAKY')], {
      ...baseCtx,
      projectByTestId: { a: 'chromium', b: 'firefox' },
    });
    expect(md).toMatchSnapshot();
    expect(md).toContain('chromium');
    expect(md).toContain('firefox');
  });

  it('escapes HTML in model- and page-controlled text', () => {
    const md = renderMarkdownSummary(
      [
        cls(
          'x',
          'REAL_BUG',
          { why: 'evil <img src=x onerror=alert(1)> tag' },
          { title: '<script>alert("t")</script> checkout' },
        ),
      ],
      baseCtx,
    );
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('<img');
    expect(md).toContain('&lt;script&gt;');
  });

  it('excludes UNCLASSIFIED from the triaged headline count', () => {
    const md = renderMarkdownSummary(
      [cls('a', 'REAL_BUG'), cls('b', 'UNCLASSIFIED', { confidence: 0, why: 'API error' })],
      baseCtx,
    );
    expect(md).toContain('1 failure(s) triaged · 1 unclassified');
  });

  it('counts only genuinely triaged failures in the header and lists overflow separately', () => {
    const md = renderMarkdownSummary(
      [cls('a', 'REAL_BUG'), cls('b', 'UNCLASSIFIED', { confidence: 0, why: 'beyond budget' })],
      { ...baseCtx, notes: ['1 failure(s) beyond the maxFailures cap (25)'] },
    );
    expect(md).toContain('1 failure(s) triaged');
    expect(md).toContain('beyond the maxFailures cap');
  });

  it('caps catastrophic runs under the GitHub comment size limit', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      cls(`t${i}`, 'UNCLASSIFIED', { why: 'x'.repeat(120) }),
    );
    const md = renderMarkdownSummary(many, baseCtx);
    expect(md.length).toBeLessThan(65_536);
    expect(md).toContain('more failure(s) not listed');
    expect(md).toContain('Triaged by [playwright-ai-triage]'); // footer survives capping
  });

  it('neutralizes backticks and link syntax in model-controlled text', () => {
    const md = renderMarkdownSummary(
      [
        cls('x', 'SELECTOR_DRIFT', {
          suggestedFix: 'getByRole(`button`)',
          why: 'see [evil](https://evil.example) link',
        }),
      ],
      baseCtx,
    );
    expect(md).not.toContain('getByRole(`');
    expect(md).toContain('\\[evil\\]');
  });

  it('renders delta labels: new gets full detail, persisting collapses to one line (golden)', () => {
    const md = renderMarkdownSummary(
      [
        cls('fresh', 'REAL_BUG'),
        cls('again', 'FLAKY', { suggestedFix: 'should not re-announce this' }),
      ],
      {
        ...baseCtx,
        delta: {
          labelByTestId: { fresh: 'new', again: 'persisting' },
          resolvedCount: 2,
        },
      },
    );
    expect(md).toMatchSnapshot();
    expect(md).toContain('🆕');
    expect(md).toContain('⏳');
    expect(md).toContain('2 failure(s) resolved since the last run');
    // persisting findings are collapsed: no why / no fix re-announcement
    expect(md).not.toContain('because again');
    expect(md).not.toContain('should not re-announce');
  });

  it('omits the resolved line when nothing resolved', () => {
    const md = renderMarkdownSummary([cls('a', 'REAL_BUG')], {
      ...baseCtx,
      delta: { labelByTestId: { a: 'new' }, resolvedCount: 0 },
    });
    expect(md).toContain('🆕');
    expect(md).not.toContain('resolved since the last run');
  });

  it('renders byte-identically to today when no delta context is provided (back-compat)', () => {
    const md = renderMarkdownSummary([cls('a', 'REAL_BUG')], baseCtx);
    expect(md).not.toContain('🆕');
    expect(md).not.toContain('⏳');
    expect(md).not.toContain('resolved since');
  });

  it('renders honest notes', () => {
    const md = renderMarkdownSummary([cls('a', 'UNCLASSIFIED')], {
      ...baseCtx,
      costUsd: undefined,
      notes: ['classifier API error after retries: 529'],
    });
    expect(md).toContain('classifier API error');
    expect(md).toContain('cost unavailable');
  });
});

describe('renderAllClearSummary', () => {
  it('renders the all-clear state with a resolved count (golden)', () => {
    const md = renderAllClearSummary(3, null);
    expect(md).toMatchSnapshot();
    expect(md).toContain('all clear ✅');
    expect(md).toContain('3 previously reported failure(s) resolved');
    expect(md).toContain('Triaged by [playwright-ai-triage]');
  });

  it('handles an unknown count (previous comment had no parseable block)', () => {
    const md = renderAllClearSummary(null, null);
    expect(md).toContain('All previously reported failures resolved');
    expect(md).not.toContain('null');
  });

  it('marks sharded runs in the all-clear header', () => {
    expect(renderAllClearSummary(1, { current: 2, total: 3 })).toContain('shard 2/3');
  });

  it('never names a model or cost (nothing was classified)', () => {
    const md = renderAllClearSummary(2, null);
    expect(md).not.toContain('claude');
    expect(md).not.toContain('$');
  });
});
