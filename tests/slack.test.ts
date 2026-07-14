import { describe, expect, it, vi } from 'vitest';

import type { ClassifiedFailure } from '../src/classify.js';
import { buildSlackPayload, postSlackMessage } from '../src/render/slack.js';

type SlackFetch = Parameters<typeof postSlackMessage>[2];
import type { FailurePayload } from '../src/types.js';

const failure = (
  id: string,
  klass: ClassifiedFailure['classification']['class'],
): ClassifiedFailure => ({
  payload: {
    testId: id,
    title: `test ${id}`,
    file: `/repo/${id}.spec.ts`,
    line: 3,
    errorMessage: 'x',
    stack: '',
    retries: [],
    retryThenPassed: false,
    duration: 1,
  } as FailurePayload,
  classification: { class: klass, confidence: 0.8, why: `why ${id}` },
});

const ctx = {
  model: 'claude-haiku-4-5',
  costUsd: 0.01,
  notes: [],
  shard: null,
};

describe('buildSlackPayload', () => {
  it('builds a Block Kit payload (golden)', () => {
    const payload = buildSlackPayload([failure('a', 'REAL_BUG'), failure('b', 'FLAKY')], ctx);
    expect(payload).toMatchSnapshot();
  });

  it('excludes UNCLASSIFIED from the triaged headline count', () => {
    const payload = buildSlackPayload(
      [failure('a', 'REAL_BUG'), failure('b', 'UNCLASSIFIED')],
      ctx,
    ) as { blocks: { type: string; text?: { text: string } }[] };
    const header = payload.blocks.find((b) => b.type === 'header');
    expect(header?.text?.text).toContain('1 failure(s) triaged · 1 unclassified');
  });

  it('carries the growth-loop footer in a context block', () => {
    const payload = buildSlackPayload([failure('a', 'REAL_BUG')], ctx) as {
      blocks: { type: string; elements?: { text: string }[] }[];
    };
    const context = payload.blocks.find((b) => b.type === 'context');
    expect(context?.elements?.[0]?.text).toContain('playwright-ai-triage');
  });

  it('escapes slack mrkdwn control characters in payload text', () => {
    const f = failure('a', 'REAL_BUG');
    f.payload.title = 'checkout <b> & fun > stuff';
    const json = JSON.stringify(buildSlackPayload([f], ctx));
    expect(json).toContain('&lt;b&gt;');
    expect(json).toContain('&amp;');
  });
});

describe('buildSlackPayload size caps', () => {
  it('stays within Slack block/section limits on catastrophic runs', () => {
    const many = Array.from({ length: 200 }, (_, i) => failure(`t${i}`, 'REAL_BUG'));
    const payload = buildSlackPayload(many, ctx) as {
      blocks: { type: string; text?: { text: string } }[];
    };
    expect(payload.blocks.length).toBeLessThanOrEqual(50);
    for (const block of payload.blocks) {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
    expect(JSON.stringify(payload)).toContain('more failure(s) not listed');
  });
});

describe('postSlackMessage', () => {
  it('posts to the webhook and succeeds on 2xx', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200 })) as ReturnType<typeof vi.fn> &
      SlackFetch;
    const res = await postSlackMessage({ blocks: [] }, 'https://hooks.slack.com/services/x', f);
    expect(res.ok).toBe(true);
    expect(f.mock.calls[0]![0]).toBe('https://hooks.slack.com/services/x');
  });

  it('fails open with a note on non-2xx', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 404 })) as ReturnType<typeof vi.fn> &
      SlackFetch;
    const res = await postSlackMessage({ blocks: [] }, 'https://hooks.slack.com/services/x', f);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.note).toMatch(/404/);
  });

  it('fails open when fetch throws', async () => {
    const f = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as ReturnType<typeof vi.fn> & SlackFetch;
    const res = await postSlackMessage({ blocks: [] }, 'https://hooks.slack.com/services/x', f);
    expect(res.ok).toBe(false);
  });
});
