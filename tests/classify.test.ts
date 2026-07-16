import { describe, expect, it, vi } from 'vitest';

import type { ResolvedConfig } from '../src/config.js';
import { classifyFailures, type ClassifierClient } from '../src/classify.js';
import type { FailurePayload } from '../src/types.js';

const basePayload = (id: string, overrides: Partial<FailurePayload> = {}): FailurePayload => ({
  testId: id,
  title: `test ${id}`,
  file: '/repo/t.spec.ts',
  line: 1,
  errorMessage: 'expect(received).toBe(expected)',
  stack: '',
  retries: [{ attempt: 0, status: 'failed' }],
  retryThenPassed: false,
  duration: 100,
  ...overrides,
});

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
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
  ...overrides,
});

function mockClient(
  respond: (ids: string[]) => unknown = (ids) => ({
    parsed_output: {
      classifications: ids.map((testId) => ({
        testId,
        class: 'REAL_BUG',
        confidence: 0.9,
        why: 'assertion diff cites expected vs received',
      })),
    },
    usage: { input_tokens: 1000, output_tokens: 200 },
    stop_reason: 'end_turn',
  }),
): ClassifierClient & { parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn(async (params: { messages: { content: string }[] }) => {
    const ids = [...params.messages[0]!.content.matchAll(/"testId":\s*"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    return respond(ids);
  });
  return { messages: { parse } } as unknown as ClassifierClient & {
    parse: ReturnType<typeof vi.fn>;
  };
}

const parseCalls = (client: ClassifierClient) =>
  (client as unknown as { messages: { parse: ReturnType<typeof vi.fn> } }).messages.parse.mock
    .calls;

describe('classifyFailures', () => {
  it('classifies a batch of ≤10 in a single API call, matched by testId', async () => {
    const client = mockClient();
    const payloads = Array.from({ length: 7 }, (_, i) => basePayload(`t${i}`));
    const res = await classifyFailures(payloads, config(), { client });
    expect(parseCalls(client)).toHaveLength(1);
    expect(res.classified).toHaveLength(7);
    expect(res.classified.every((c) => c.classification.class === 'REAL_BUG')).toBe(true);
  });

  it('chunks >10 failures into batches of 10', async () => {
    const client = mockClient();
    const payloads = Array.from({ length: 23 }, (_, i) => basePayload(`t${i}`));
    const res = await classifyFailures(payloads, config(), { client });
    expect(parseCalls(client)).toHaveLength(3);
    expect(res.classified).toHaveLength(23);
  });

  it('marks payloads missing from the response UNCLASSIFIED', async () => {
    const client = mockClient((ids) => ({
      parsed_output: {
        classifications: [
          { testId: ids[0], class: 'FLAKY', confidence: 0.8, why: 'passed on retry' },
        ],
      },
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: 'end_turn',
    }));
    const res = await classifyFailures([basePayload('a'), basePayload('b')], config(), { client });
    const byId = Object.fromEntries(res.classified.map((c) => [c.payload.testId, c]));
    expect(byId.a!.classification.class).toBe('FLAKY');
    expect(byId.b!.classification.class).toBe('UNCLASSIFIED');
  });

  it('caps at maxFailures — overflow is UNCLASSIFIED with a note, no API call for it', async () => {
    const client = mockClient();
    const payloads = Array.from({ length: 5 }, (_, i) => basePayload(`t${i}`));
    const res = await classifyFailures(payloads, config({ maxFailures: 3 }), { client });
    const unclassified = res.classified.filter((c) => c.classification.class === 'UNCLASSIFIED');
    expect(unclassified).toHaveLength(2);
    expect(res.notes.join(' ')).toMatch(/maxFailures/);
    expect(parseCalls(client)[0]![0].messages[0].content.match(/"testId"/g)).toHaveLength(3);
  });

  it('short-circuits pure network failures locally as ENV_ISSUE without an API call', async () => {
    const client = mockClient();
    const payloads = [
      basePayload('net', { errorMessage: 'page.goto: net::ERR_CONNECTION_REFUSED' }),
    ];
    const res = await classifyFailures(payloads, config(), { client });
    expect(parseCalls(client)).toHaveLength(0);
    expect(res.classified[0]!.classification.class).toBe('ENV_ISSUE');
  });

  it('classifies retry-then-passed locally as FLAKY without an API call', async () => {
    const client = mockClient();
    const payloads = [basePayload('fl', { retryThenPassed: true })];
    const res = await classifyFailures(payloads, config(), { client });
    expect(parseCalls(client)).toHaveLength(0);
    expect(res.classified[0]!.classification.class).toBe('FLAKY');
    expect(res.notes.join(' ')).toMatch(/classified locally.*no tokens/);
  });

  it('classifies explicit expired-credential failures locally as ENV_ISSUE', async () => {
    const client = mockClient();
    const payloads = [
      basePayload('pat', {
        errorMessage:
          'ADO GET failed: 401 Unauthorized | Access Denied: The Personal Access Token used has expired.',
      }),
    ];
    const res = await classifyFailures(payloads, config(), { client });
    expect(parseCalls(client)).toHaveLength(0);
    expect(res.classified[0]!.classification.class).toBe('ENV_ISSUE');
  });

  it('attaches heuristic priors to ambiguous payloads sent to the model', async () => {
    const client = mockClient();
    const payloads = [
      basePayload('mix', {
        errorMessage:
          'TimeoutError: waiting for locator("#x") — page.goto: net::ERR_CONNECTION_RESET',
      }),
    ];
    await classifyFailures(payloads, config(), { client });
    expect(parseCalls(client)[0]![0].messages[0].content).toContain(
      '"heuristicPrior": "ENV_ISSUE"',
    );
  });

  it.each([
    [
      'refusal',
      { parsed_output: null, usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: 'refusal' },
    ],
    [
      'truncation',
      {
        parsed_output: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'max_tokens',
      },
    ],
    [
      'null parse',
      {
        parsed_output: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      },
    ],
  ])('fails closed to UNCLASSIFIED on %s', async (_name, response) => {
    const client = mockClient(() => response);
    const res = await classifyFailures([basePayload('x')], config(), { client });
    expect(res.classified[0]!.classification.class).toBe('UNCLASSIFIED');
    expect(res.notes.length).toBeGreaterThan(0);
  });

  it('fails closed to UNCLASSIFIED when the SDK throws (retries exhausted)', async () => {
    const client = {
      messages: { parse: vi.fn().mockRejectedValue(new Error('529 overloaded')) },
    } as unknown as ClassifierClient;
    const res = await classifyFailures([basePayload('x')], config(), { client });
    expect(res.classified[0]!.classification.class).toBe('UNCLASSIFIED');
    expect(res.notes.join(' ')).toMatch(/overloaded|API/i);
  });

  it('computes run cost from usage at Haiku pricing', async () => {
    const client = mockClient((ids) => ({
      parsed_output: {
        classifications: ids.map((testId) => ({ testId, class: 'FLAKY', confidence: 1, why: 'w' })),
      },
      usage: { input_tokens: 1_000_000, output_tokens: 200_000 },
      stop_reason: 'end_turn',
    }));
    const res = await classifyFailures([basePayload('x')], config(), { client });
    expect(res.costUsd).toBeCloseTo(1 + 0.2 * 5, 5); // $1 input + $1 output
  });

  it('reports cost as undefined for unknown models instead of guessing', async () => {
    const client = mockClient();
    const res = await classifyFailures([basePayload('x')], config({ model: 'future-model' }), {
      client,
    });
    expect(res.costUsd).toBeUndefined();
  });

  it('dryRun produces deterministic fixtures with zero API interaction', async () => {
    const client = mockClient();
    const payloads = [basePayload('net', { errorMessage: 'ECONNREFUSED' }), basePayload('plain')];
    const res = await classifyFailures(payloads, config({ dryRun: true, apiKey: undefined }), {
      client,
    });
    expect(parseCalls(client)).toHaveLength(0);
    expect(res.classified).toHaveLength(2);
    expect(res.costUsd).toBe(0);
  });

  it('does not mutate caller-owned payloads when attaching priors', async () => {
    const client = mockClient();
    const payload = basePayload('fl', { retryThenPassed: true });
    await classifyFailures([payload], config(), { client });
    expect(payload.heuristicPrior).toBeUndefined();
  });

  it('clamps out-of-range confidence values', async () => {
    const client = mockClient((ids) => ({
      parsed_output: {
        classifications: ids.map((testId) => ({ testId, class: 'FLAKY', confidence: 3, why: 'w' })),
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    }));
    const res = await classifyFailures([basePayload('x')], config(), { client });
    expect(res.classified[0]!.classification.confidence).toBe(1);
  });
});
