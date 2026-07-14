import { describe, expect, it } from 'vitest';

import type { ClassifiedFailure } from '../src/classify.js';
import { renderStdoutSummary } from '../src/summary.js';
import type { Classification, FailurePayload } from '../src/types.js';

const cls = (id: string, klass: Classification['class']): ClassifiedFailure => ({
  payload: {
    testId: id,
    title: `test ${id}`,
    file: `t/${id}.spec.ts`,
    line: 1,
    errorMessage: 'x',
    stack: '',
    retries: [{ attempt: 0, status: 'failed' }],
    retryThenPassed: false,
    duration: 1,
  } as FailurePayload,
  classification: { class: klass, confidence: 0.9, why: `because ${id}` },
});

describe('renderStdoutSummary', () => {
  it('does not count UNCLASSIFIED as triaged; reports it separately', () => {
    const out = renderStdoutSummary(
      [cls('a', 'REAL_BUG'), cls('b', 'UNCLASSIFIED'), cls('c', 'UNCLASSIFIED')],
      0,
      [],
      'claude-haiku-4-5',
    );
    expect(out).toContain('1 failure(s) triaged · 2 unclassified');
  });

  it('keeps the plain headline when everything classified', () => {
    const out = renderStdoutSummary([cls('a', 'FLAKY')], 0.01, [], 'claude-haiku-4-5');
    expect(out).toContain('1 failure(s) triaged');
    expect(out).not.toContain('unclassified');
  });

  it('names no model on the cost line when no API call was made (keyless)', () => {
    const out = renderStdoutSummary([cls('a', 'FLAKY'), cls('b', 'UNCLASSIFIED')], 0, [], null);
    expect(out).toContain('cost of this run: $0.0000 (no API calls made)');
    expect(out).not.toContain('claude');
  });

  it('still names the model when it was actually called', () => {
    const out = renderStdoutSummary([cls('a', 'REAL_BUG')], 0.0123, [], 'claude-haiku-4-5');
    expect(out).toContain('$0.0123 (claude-haiku-4-5)');
  });
});
