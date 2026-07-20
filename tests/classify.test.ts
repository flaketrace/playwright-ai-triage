import { describe, expect, it, vi } from 'vitest';

import type { ResolvedConfig } from '../src/config.js';
import { classifyFailures, type ClassifierClient, type StickyClassMap } from '../src/classify.js';
import { failureFingerprint } from '../src/fingerprint.js';
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

describe('sticky reuse (R2 — D2 rules)', () => {
  const stickyFor = (
    payloads: FailurePayload[],
    cls: Parameters<StickyClassMap['set']>[1]['class'] = 'ENV_ISSUE',
    confidence = 0.8,
  ): StickyClassMap =>
    new Map(payloads.map((p) => [failureFingerprint(p), { class: cls, confidence }]));

  it('reuses the stored class for a matching fingerprint without an API call', async () => {
    const client = mockClient();
    const known = basePayload('known');
    const fresh = basePayload('fresh', { errorMessage: 'different failure shape' });
    const sticky = stickyFor([known]);
    const res = await classifyFailures([known, fresh], config(), { client, sticky });

    const reusedEntry = res.classified.find((c) => c.payload.testId === 'known')!;
    expect(reusedEntry.classification.class).toBe('ENV_ISSUE');
    expect(reusedEntry.classification.confidence).toBe(0.8);
    expect(reusedEntry.classification.why).toMatch(/previous run/);
    expect(reusedEntry.reused).toBe(true);

    // only the fresh payload reached the model
    expect(parseCalls(client)).toHaveLength(1);
    expect(JSON.stringify(parseCalls(client)[0])).not.toContain('"known"');
    expect(res.notes.some((n) => n.includes('reused prior classification'))).toBe(true);
  });

  it('never reuses a stored UNCLASSIFIED (fail-closed states do not persist)', async () => {
    const client = mockClient();
    const p = basePayload('t1');
    const sticky = stickyFor([p], 'UNCLASSIFIED', 0);
    const res = await classifyFailures([p], config(), { client, sticky });
    expect(parseCalls(client)).toHaveLength(1); // went to the model
    expect(res.classified[0]!.classification.class).toBe('REAL_BUG');
    expect(res.classified[0]!.reused).toBeUndefined();
  });

  it('heuristic local verdicts win over sticky (deterministic + free beats stored)', async () => {
    const client = mockClient();
    const p = basePayload('flaky1', {
      retries: [
        { attempt: 0, status: 'failed' },
        { attempt: 1, status: 'passed' },
      ],
      retryThenPassed: true,
    });
    const sticky = stickyFor([p], 'REAL_BUG', 0.9);
    const res = await classifyFailures([p], config(), { client, sticky });
    expect(res.classified[0]!.classification.class).toBe('FLAKY');
    expect(res.classified[0]!.reused).toBeUndefined();
    expect(parseCalls(client)).toHaveLength(0);
  });

  it('ignores sticky on keyless runs', async () => {
    const client = mockClient();
    const p = basePayload('t1');
    const sticky = stickyFor([p]);
    const res = await classifyFailures([p], config({ apiKey: undefined }), { client, sticky });
    expect(res.classified[0]!.classification.class).toBe('UNCLASSIFIED');
    expect(res.classified[0]!.reused).toBeUndefined();
    expect(parseCalls(client)).toHaveLength(0);
    expect(res.notes.some((n) => n.includes('reused prior classification'))).toBe(false);
  });

  it('ignores sticky in dryRun', async () => {
    const client = mockClient();
    const p = basePayload('t1');
    const sticky = stickyFor([p], 'REAL_BUG', 0.9);
    const res = await classifyFailures([p], config({ dryRun: true }), { client, sticky });
    expect(res.classified[0]!.classification.why).toContain('dry-run');
    expect(res.classified[0]!.reused).toBeUndefined();
    expect(parseCalls(client)).toHaveLength(0);
    expect(res.notes.some((n) => n.includes('reused prior classification'))).toBe(false);
  });

  it('reused failures do not consume the maxFailures budget', async () => {
    const client = mockClient();
    const known = basePayload('known');
    const fresh = basePayload('fresh', { errorMessage: 'different failure shape' });
    const sticky = stickyFor([known]);
    const res = await classifyFailures([known, fresh], config({ maxFailures: 1 }), {
      client,
      sticky,
    });
    expect(res.overflowCount).toBe(0);
    const freshEntry = res.classified.find((c) => c.payload.testId === 'fresh')!;
    expect(freshEntry.classification.class).toBe('REAL_BUG');
  });
});

describe('vote-on-first (D6 — majority of 3 draws)', () => {
  /** Client whose responses cycle per call: draw i answers with classes[i % n]. */
  const votingClient = (
    perDraw: { class: string; confidence: number }[],
  ): ClassifierClient & { parse: ReturnType<typeof vi.fn> } => {
    let call = 0;
    const parse = vi.fn(async (params: { messages: { content: string }[] }) => {
      const ids = [...params.messages[0]!.content.matchAll(/"testId":\s*"([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      const draw = perDraw[call % perDraw.length]!;
      call += 1;
      return {
        parsed_output: {
          classifications: ids.map((testId) => ({
            testId,
            class: draw.class,
            confidence: draw.confidence,
            why: `draw says ${draw.class}`,
          })),
        },
        usage: { input_tokens: 1000, output_tokens: 200 },
        stop_reason: 'end_turn',
      };
    });
    return { messages: { parse } } as unknown as ClassifierClient & {
      parse: ReturnType<typeof vi.fn>;
    };
  };

  it('issues 3 draws per batch and records the 2/3 majority with mean-of-majority confidence', async () => {
    const client = votingClient([
      { class: 'REAL_BUG', confidence: 0.7 },
      { class: 'ENV_ISSUE', confidence: 0.9 },
      { class: 'REAL_BUG', confidence: 0.8 },
    ]);
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    expect(parseCalls(client)).toHaveLength(3);
    const c = res.classified[0]!;
    expect(c.classification.class).toBe('REAL_BUG');
    expect(c.classification.confidence).toBeCloseTo(0.75, 5);
    expect(c.draws).toHaveLength(3);
    expect(c.draws!.map((d) => d.class)).toEqual(['REAL_BUG', 'ENV_ISSUE', 'REAL_BUG']);
  });

  it('a unanimous 3/3 keeps the class with mean confidence', async () => {
    const client = votingClient([
      { class: 'FLAKY', confidence: 0.6 },
      { class: 'FLAKY', confidence: 0.7 },
      { class: 'FLAKY', confidence: 0.8 },
    ]);
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    expect(res.classified[0]!.classification.class).toBe('FLAKY');
    expect(res.classified[0]!.classification.confidence).toBeCloseTo(0.7, 5);
  });

  it('a 3-way split fails closed to UNCLASSIFIED naming the split', async () => {
    const client = votingClient([
      { class: 'REAL_BUG', confidence: 0.7 },
      { class: 'ENV_ISSUE', confidence: 0.9 },
      { class: 'SELECTOR_DRIFT', confidence: 0.8 },
    ]);
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    const c = res.classified[0]!;
    expect(c.classification.class).toBe('UNCLASSIFIED');
    expect(c.classification.confidence).toBe(0);
    expect(c.classification.why).toMatch(
      /no majority across 3 draws \(REAL_BUG \/ ENV_ISSUE \/ SELECTOR_DRIFT\)/,
    );
  });

  it('vote absent keeps single-draw behavior', async () => {
    const client = mockClient();
    await classifyFailures([basePayload('t1')], config(), { client });
    expect(parseCalls(client)).toHaveLength(1);
  });

  it('sums usage across all draws into the cost', async () => {
    const client = votingClient([
      { class: 'REAL_BUG', confidence: 0.7 },
      { class: 'REAL_BUG', confidence: 0.7 },
      { class: 'REAL_BUG', confidence: 0.7 },
    ]);
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    // 3 draws × (1000 in + 200 out) at Haiku pricing (1 / 5 per MTok)
    expect(res.costUsd).toBeCloseTo(3 * (0.001 + 0.001), 6);
  });

  it('sticky reuse bypasses voting entirely (no draws for persisting fingerprints)', async () => {
    const client = votingClient([{ class: 'REAL_BUG', confidence: 0.7 }]);
    const known = basePayload('known');
    const sticky = new Map([
      [failureFingerprint(known), { class: 'ENV_ISSUE' as const, confidence: 0.8 }],
    ]);
    const res = await classifyFailures([known], config(), { client, sticky, vote: true });
    expect(parseCalls(client)).toHaveLength(0);
    expect(res.classified[0]!.reused).toBe(true);
  });

  it('a refused draw is skipped; majority of the surviving two agreeing draws wins', async () => {
    let call = 0;
    const parse = vi.fn(async (params: { messages: { content: string }[] }) => {
      const ids = [...params.messages[0]!.content.matchAll(/"testId":\s*"([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      call += 1;
      if (call === 2) {
        return {
          parsed_output: null,
          usage: { input_tokens: 1000, output_tokens: 200 },
          stop_reason: 'refusal',
        };
      }
      return {
        parsed_output: {
          classifications: ids.map((testId) => ({
            testId,
            class: 'ENV_ISSUE',
            confidence: 0.6,
            why: 'draw',
          })),
        },
        usage: { input_tokens: 1000, output_tokens: 200 },
        stop_reason: 'end_turn',
      };
    });
    const client = { messages: { parse } } as unknown as ClassifierClient;
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    expect(res.classified[0]!.classification.class).toBe('ENV_ISSUE');
    expect(res.notes.some((n) => n.includes('refusal on a vote draw'))).toBe(true);
  });

  it('a schema-invalid draw is skipped with a note; survivors still form the majority', async () => {
    let call = 0;
    const parse = vi.fn(async (params: { messages: { content: string }[] }) => {
      const ids = [...params.messages[0]!.content.matchAll(/"testId":\s*"([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      call += 1;
      if (call === 3) {
        return {
          parsed_output: null,
          usage: { input_tokens: 1000, output_tokens: 200 },
          stop_reason: 'end_turn',
        };
      }
      return {
        parsed_output: {
          classifications: ids.map((testId) => ({
            testId,
            class: 'FLAKY',
            confidence: 0.7,
            why: 'draw',
          })),
        },
        usage: { input_tokens: 1000, output_tokens: 200 },
        stop_reason: 'end_turn',
      };
    });
    const client = { messages: { parse } } as unknown as ClassifierClient;
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    expect(res.classified[0]!.classification.class).toBe('FLAKY');
    expect(res.notes.some((n) => n.includes('no schema-valid output for a vote draw'))).toBe(true);
  });

  it('all three draws failing falls closed exactly like the single-draw error path', async () => {
    const parse = vi.fn(async () => {
      throw new Error('down');
    });
    const client = { messages: { parse } } as unknown as ClassifierClient;
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    expect(res.classified[0]!.classification.class).toBe('UNCLASSIFIED');
    expect(res.classified[0]!.classification.why).toBe('classifier API error');
  });

  it('a payload absent from every surviving draw is UNCLASSIFIED', async () => {
    const parse = vi.fn(async () => ({
      parsed_output: { classifications: [] },
      usage: { input_tokens: 1000, output_tokens: 200 },
      stop_reason: 'end_turn',
    }));
    const client = { messages: { parse } } as unknown as ClassifierClient;
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    expect(res.classified[0]!.classification.class).toBe('UNCLASSIFIED');
    expect(res.classified[0]!.classification.why).toBe('no schema-valid classification returned');
  });

  it('a 1-1 tie across two surviving draws fails closed naming the split', async () => {
    let call = 0;
    const parse = vi.fn(async (params: { messages: { content: string }[] }) => {
      const ids = [...params.messages[0]!.content.matchAll(/"testId":\s*"([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      call += 1;
      if (call === 3) throw new Error('boom');
      const cls = call === 1 ? 'REAL_BUG' : 'ENV_ISSUE';
      return {
        parsed_output: {
          classifications: ids.map((testId) => ({
            testId,
            class: cls,
            confidence: 0.8,
            why: 'draw',
          })),
        },
        usage: { input_tokens: 1000, output_tokens: 200 },
        stop_reason: 'end_turn',
      };
    });
    const client = { messages: { parse } } as unknown as ClassifierClient;
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    const c = res.classified[0]!;
    expect(c.classification.class).toBe('UNCLASSIFIED');
    expect(c.classification.why).toMatch(/no majority across 2 draws/);
  });

  it('a failed draw (API error) falls back to majority of the remaining two when they agree', async () => {
    let call = 0;
    const parse = vi.fn(async (params: { messages: { content: string }[] }) => {
      const ids = [...params.messages[0]!.content.matchAll(/"testId":\s*"([^"]+)"/g)].map(
        (m) => m[1]!,
      );
      call += 1;
      if (call === 2) throw new Error('boom');
      return {
        parsed_output: {
          classifications: ids.map((testId) => ({
            testId,
            class: 'REAL_BUG',
            confidence: 0.8,
            why: 'draw',
          })),
        },
        usage: { input_tokens: 1000, output_tokens: 200 },
        stop_reason: 'end_turn',
      };
    });
    const client = { messages: { parse } } as unknown as ClassifierClient;
    const res = await classifyFailures([basePayload('t1')], config(), { client, vote: true });
    expect(res.classified[0]!.classification.class).toBe('REAL_BUG');
    expect(res.classified[0]!.classification.confidence).toBeCloseTo(0.8, 5);
  });
});
