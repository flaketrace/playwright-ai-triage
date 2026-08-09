import { describe, expect, it } from 'vitest';

import type { ClassifierClient } from '../src/classify.js';
import type { ResolvedConfig } from '../src/config.js';
import { classifyWithSelfConsistency, summarizeDraws } from '../src/reliability.js';
import type { Classification, FailurePayload } from '../src/types.js';

const classification = (overrides: Partial<Classification> = {}): Classification => ({
  class: 'REAL_BUG',
  confidence: 0.9,
  why: 'test',
  ...overrides,
});

describe('summarizeDraws', () => {
  it('returns undefined for no draws', () => {
    expect(summarizeDraws([])).toBeUndefined();
  });

  it('a unanimous set is stable, with confidence averaged', () => {
    const s = summarizeDraws([
      classification({ confidence: 0.6 }),
      classification({ confidence: 0.8 }),
    ])!;
    expect(s.classification.class).toBe('REAL_BUG');
    expect(s.classification.confidence).toBeCloseTo(0.7, 5);
    expect(s).toMatchObject({ agreeing: 2, total: 2, unstable: false });
  });

  it('grades the majority and flags the split as unstable', () => {
    const s = summarizeDraws([
      classification({ class: 'REAL_BUG' }),
      classification({ class: 'ENV_ISSUE' }),
      classification({ class: 'REAL_BUG' }),
    ])!;
    expect(s.classification.class).toBe('REAL_BUG');
    expect(s).toMatchObject({ agreeing: 2, total: 3, unstable: true, tied: false });
  });

  it('averages confidence over the majority only, ignoring dissenting draws', () => {
    const s = summarizeDraws([
      classification({ class: 'REAL_BUG', confidence: 0.7 }),
      classification({ class: 'ENV_ISSUE', confidence: 0.1 }),
      classification({ class: 'REAL_BUG', confidence: 0.9 }),
    ])!;
    expect(s.classification.confidence).toBeCloseTo(0.8, 5);
  });

  it('a 1-1 tie is flagged indeterminate so the caller cannot grade a coin flip', () => {
    const s = summarizeDraws([
      classification({ class: 'ENV_ISSUE' }),
      classification({ class: 'REAL_BUG' }),
    ])!;
    expect(s).toMatchObject({ agreeing: 1, total: 2, unstable: true, tied: true });
  });

  it('a three-way split with no majority is tied', () => {
    const s = summarizeDraws([
      classification({ class: 'REAL_BUG' }),
      classification({ class: 'ENV_ISSUE' }),
      classification({ class: 'FLAKY' }),
    ])!;
    expect(s.tied).toBe(true);
  });

  it('a 2-2-1 split is tied even though one class leads the singleton', () => {
    const s = summarizeDraws([
      classification({ class: 'REAL_BUG' }),
      classification({ class: 'ENV_ISSUE' }),
      classification({ class: 'REAL_BUG' }),
      classification({ class: 'ENV_ISSUE' }),
      classification({ class: 'FLAKY' }),
    ])!;
    expect(s).toMatchObject({ agreeing: 2, total: 5, tied: true });
  });

  it('a clear 2-1 majority is unstable but NOT tied — it is gradeable', () => {
    const s = summarizeDraws([
      classification({ class: 'REAL_BUG' }),
      classification({ class: 'ENV_ISSUE' }),
      classification({ class: 'REAL_BUG' }),
    ])!;
    expect(s).toMatchObject({ agreeing: 2, total: 3, unstable: true, tied: false });
  });

  it('a single draw is trivially stable — the status-quo measurement', () => {
    const s = summarizeDraws([classification()])!;
    expect(s).toMatchObject({ agreeing: 1, total: 1, unstable: false, tied: false });
  });
});

const basePayload: FailurePayload = {
  testId: 'a',
  title: 'test a',
  file: '/repo/t.spec.ts',
  line: 1,
  errorMessage: 'expect(received).toBe(expected)',
  stack: '',
  retries: [{ attempt: 0, status: 'failed' }],
  retryThenPassed: false,
  duration: 100,
};

const baseConfig: ResolvedConfig = {
  model: 'claude-haiku-4-5',
  outputs: ['stdout'],
  includeDom: false,
  maxFailures: 25,
  dryRun: false,
  failSilently: true,
  apiKey: 'sk-ant-test',
  githubToken: undefined,
  slackWebhookUrl: undefined,
  diffSummary: undefined,
  sinkUrl: undefined,
  sinkToken: undefined,
};

/** Sequenced mock: each call to messages.parse returns the next queued response. */
function sequencedClient(
  responses: { class: string; confidence: number }[],
): ClassifierClient & { calls: number } {
  let call = 0;
  const client = {
    calls: 0,
    messages: {
      parse: async () => {
        const next = responses[call] ?? responses[responses.length - 1]!;
        call += 1;
        client.calls = call;
        return {
          parsed_output: {
            classifications: [
              { testId: 'a', class: next.class, confidence: next.confidence, why: 'test' },
            ],
          },
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'end_turn',
        };
      },
    },
  } as unknown as ClassifierClient & { calls: number };
  return client;
}

describe('classifyWithSelfConsistency', () => {
  it('makes one API call per draw and collapses via summarizeDraws', async () => {
    const client = sequencedClient([
      { class: 'REAL_BUG', confidence: 0.9 },
      { class: 'REAL_BUG', confidence: 0.8 },
      { class: 'REAL_BUG', confidence: 0.7 },
    ]);
    const result = await classifyWithSelfConsistency(basePayload, baseConfig, 3, { client });
    expect(client.calls).toBe(3);
    expect(result?.summary).toMatchObject({ agreeing: 3, total: 3, unstable: false, tied: false });
    expect(result?.summary.classification.class).toBe('REAL_BUG');
  });

  it('surfaces a tie when draws split evenly', async () => {
    const client = sequencedClient([
      { class: 'REAL_BUG', confidence: 0.9 },
      { class: 'FLAKY', confidence: 0.6 },
    ]);
    const result = await classifyWithSelfConsistency(basePayload, baseConfig, 2, { client });
    expect(result?.summary.tied).toBe(true);
  });

  it('sums cost across all draws', async () => {
    const client = sequencedClient([{ class: 'REAL_BUG', confidence: 0.9 }]);
    const result = await classifyWithSelfConsistency(basePayload, baseConfig, 2, { client });
    // 100 input / 50 output tokens per draw, claude-haiku-4-5 pricing ($1/$5 per 1M), 2 draws
    expect(result?.costUsd).toBeCloseTo(2 * ((100 / 1_000_000) * 1 + (50 / 1_000_000) * 5), 8);
  });
});
