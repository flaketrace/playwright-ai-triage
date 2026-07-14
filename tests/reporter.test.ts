import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AiTriageReporter from '../src/index.js';
import type { ClassifierClient } from '../src/classify.js';

function fakeTest(id: string, overrides: Partial<Record<string, unknown>> = {}): TestCase {
  return {
    id,
    title: `test ${id}`,
    location: { file: '/repo/t.spec.ts', line: 1, column: 1 },
    outcome: () => 'unexpected',
    results: [{ retry: 0, status: 'failed' }],
    ...overrides,
  } as unknown as TestCase;
}

function failedResult(overrides: Partial<Record<string, unknown>> = {}): TestResult {
  return {
    retry: 0,
    status: 'failed',
    duration: 10,
    errors: [{ message: 'expect(a).toBe(b)', stack: '' }],
    steps: [],
    attachments: [],
    ...overrides,
  } as unknown as TestResult;
}

const fullResult = { status: 'failed' } as FullResult;

function okClient(): ClassifierClient {
  return {
    messages: {
      parse: vi.fn(async (params: { messages: { content: string }[] }) => {
        const ids = [...params.messages[0]!.content.matchAll(/"testId":\s*"([^"]+)"/g)].map(
          (m) => m[1]!,
        );
        return {
          parsed_output: {
            classifications: ids.map((testId) => ({
              testId,
              class: 'REAL_BUG',
              confidence: 0.9,
              why: 'assertion mismatch',
            })),
          },
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'end_turn',
        };
      }),
    },
  } as unknown as ClassifierClient;
}

describe('AiTriageReporter', () => {
  let logs: string[];
  let warns: string[];

  beforeEach(() => {
    logs = [];
    warns = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => void warns.push(a.join(' ')));
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('SLACK_WEBHOOK_URL', '');
    // hermetic: never let a dev shell's real GH credentials reach global fetch
    vi.stubEnv('GITHUB_REPOSITORY', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GITHUB_REF', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function run(reporter: AiTriageReporter, failures: [TestCase, TestResult][]): Promise<unknown> {
    reporter.onBegin({} as FullConfig, {} as Suite);
    for (const [t, r] of failures) reporter.onTestEnd(t, r);
    return reporter.onEnd(fullResult);
  }

  it('classifies failures and prints a summary (happy path)', async () => {
    const reporter = new AiTriageReporter({}, { client: okClient() });
    const returned = await run(reporter, [[fakeTest('a'), failedResult()]]);
    expect(returned).toBeUndefined(); // MUST never override exit status
    const out = logs.join('\n');
    expect(out).toContain('REAL_BUG');
    expect(out).toContain('test a');
  });

  it('prints only a one-liner on zero failures', async () => {
    const reporter = new AiTriageReporter({}, { client: okClient() });
    await run(reporter, []);
    expect(logs.join('\n')).toMatch(/no failures/i);
  });

  it('degrades to a plain summary + hint when no API key is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const client = okClient();
    const reporter = new AiTriageReporter({}, { client });
    const returned = await run(reporter, [[fakeTest('a'), failedResult()]]);
    expect(returned).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('test a');
    expect(out).toMatch(/ANTHROPIC_API_KEY/);
    expect(
      (client as unknown as { messages: { parse: ReturnType<typeof vi.fn> } }).messages.parse,
    ).not.toHaveBeenCalled();
  });

  it('keyless: deterministic local verdicts still classify — full summary, zero API calls', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const client = okClient();
    const reporter = new AiTriageReporter({}, { client });
    const returned = await run(reporter, [
      [fakeTest('fl', { outcome: () => 'flaky' }), failedResult()],
      [fakeTest('plain'), failedResult()],
    ]);
    expect(returned).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('FLAKY'); // retry-then-passed classified locally
    expect(out).toContain('UNCLASSIFIED'); // the ambiguous one stays honest
    expect(out).toMatch(/ANTHROPIC_API_KEY/); // hint note still present
    expect(
      (client as unknown as { messages: { parse: ReturnType<typeof vi.fn> } }).messages.parse,
    ).not.toHaveBeenCalled();
  });

  it('never fails the build when the classifier blows up', async () => {
    const client = {
      messages: { parse: vi.fn().mockRejectedValue(new Error('kaboom')) },
    } as unknown as ClassifierClient;
    const reporter = new AiTriageReporter({}, { client });
    const returned = await run(reporter, [[fakeTest('a'), failedResult()]]);
    expect(returned).toBeUndefined();
    // fail-closed classification still yields a summary with UNCLASSIFIED
    expect(logs.join('\n')).toContain('UNCLASSIFIED');
  });

  it('never fails the build even when rendering itself throws (internal error path)', async () => {
    const reporter = new AiTriageReporter({}, { client: okClient() });
    reporter.onBegin({} as FullConfig, {} as Suite);
    // sabotage internal state to force an unexpected throw inside onEnd
    (reporter as unknown as { failures: unknown }).failures = null;
    const returned = await reporter.onEnd(fullResult);
    expect(returned).toBeUndefined();
    expect(warns.join('\n')).toMatch(/internal error/i);
  });

  it('emits a GitHub warning annotation for internal errors when failSilently is false on GH Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const reporter = new AiTriageReporter({ failSilently: false }, { client: okClient() });
    reporter.onBegin({} as FullConfig, {} as Suite);
    (reporter as unknown as { failures: unknown }).failures = null;
    await reporter.onEnd(fullResult);
    expect(logs.join('\n')).toContain('::warning');
  });

  it('emits no ::warning noise outside GitHub Actions even with failSilently false', async () => {
    const reporter = new AiTriageReporter({ failSilently: false }, { client: okClient() });
    reporter.onBegin({} as FullConfig, {} as Suite);
    (reporter as unknown as { failures: unknown }).failures = null;
    await reporter.onEnd(fullResult);
    expect(logs.join('\n')).not.toContain('::warning');
  });

  it('skips expected failures (test.fail() annotations) — green builds are never triaged', async () => {
    const client = okClient();
    const reporter = new AiTriageReporter({}, { client });
    const expectedFailure = fakeTest('exp', { outcome: () => 'expected' });
    await run(reporter, [[expectedFailure, failedResult()]]);
    expect(logs.join('\n')).toMatch(/no failures/i);
    expect(
      (client as unknown as { messages: { parse: ReturnType<typeof vi.fn> } }).messages.parse,
    ).not.toHaveBeenCalled();
  });

  it('dryRun classifies without any client', async () => {
    const reporter = new AiTriageReporter({ dryRun: true });
    const returned = await run(reporter, [[fakeTest('a'), failedResult()]]);
    expect(returned).toBeUndefined();
    expect(logs.join('\n')).toMatch(/dry.?run/i);
  });

  it('keeps only the last result per test across retries', async () => {
    const client = okClient();
    const reporter = new AiTriageReporter({}, { client });
    const test = fakeTest('a');
    await run(reporter, [
      [test, failedResult({ retry: 0 })],
      [test, failedResult({ retry: 1 })],
    ]);
    const content = (client as unknown as { messages: { parse: ReturnType<typeof vi.fn> } })
      .messages.parse.mock.calls[0]![0].messages[0].content;
    expect(content.match(/"testId"/g)).toHaveLength(1);
  });

  it('declares that it prints to stdio', () => {
    expect(new AiTriageReporter().printsToStdio()).toBe(true);
  });

  it('encodes multi-line internal errors for GitHub annotations (%0A)', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const reporter = new AiTriageReporter({ failSilently: false }, { client: okClient() });
    reporter.onBegin({} as FullConfig, {} as Suite);
    (reporter as unknown as { failures: unknown }).failures = {
      values() {
        throw new Error('line one\nline two');
      },
    };
    await reporter.onEnd(fullResult);
    const annotation = logs.find((l) => l.includes('::warning'));
    expect(annotation).toContain('line one%0Aline two');
  });

  it('posts a GitHub PR comment when the github output is active', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
    vi.stubEnv('GITHUB_REF', 'refs/pull/9/merge');
    vi.stubEnv('GITHUB_TOKEN', 'tkn');
    const fetchImpl = vi.fn(async (_url: string, init?: { method?: string }) =>
      !init?.method || init.method === 'GET'
        ? { ok: true, status: 200, json: async () => [] }
        : { ok: true, status: 201, json: async () => ({}) },
    );
    const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
    await run(reporter, [[fakeTest('a'), failedResult()]]);
    expect(fetchImpl.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(true);
  });

  it('sends to Slack when the slack output is active', async () => {
    vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/x');
    const fetchImpl = vi.fn(async (_url: string, _init?: { method?: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
    await run(reporter, [[fakeTest('a'), failedResult()]]);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://hooks.slack.com/services/x');
  });

  it('suppresses the full stdout summary when stdout is not in outputs', async () => {
    const reporter = new AiTriageReporter({ outputs: ['github'] }, { client: okClient() });
    await run(reporter, [[fakeTest('a'), failedResult()]]);
    const out = logs.join('\n');
    expect(out).not.toContain('REAL_BUG');
    expect(out).toMatch(/triaged/i);
  });

  it('a failing sender never affects the run (fail-open per sender)', async () => {
    vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/x');
    const fetchImpl = vi.fn(async (_url: string, _init?: { method?: string }) => {
      throw new Error('slack down');
    });
    const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
    const returned = await run(reporter, [[fakeTest('a'), failedResult()]]);
    expect(returned).toBeUndefined();
    expect(warns.join('\n')).toMatch(/slack/i);
    expect(logs.join('\n')).toContain('REAL_BUG'); // stdout summary still printed
  });

  it('warns when slack is requested but no webhook is configured', async () => {
    const reporter = new AiTriageReporter({ outputs: ['stdout', 'slack'] }, { client: okClient() });
    await run(reporter, [[fakeTest('a'), failedResult()]]);
    expect(warns.join('\n')).toMatch(/SLACK_WEBHOOK_URL is not set/);
  });

  it('posts nothing anywhere on zero failures', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/x');
    const fetchImpl = vi.fn();
    const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
    await run(reporter, []);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('delta comments (R1 + R3)', () => {
    const stubPrContext = () => {
      vi.stubEnv('GITHUB_ACTIONS', 'true');
      vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
      vi.stubEnv('GITHUB_REF', 'refs/pull/9/merge');
      vi.stubEnv('GITHUB_TOKEN', 'tkn');
    };

    function ghFetch(existingComments: { id: number; body: string }[]) {
      return vi.fn(async (_url: string, init?: { method?: string }) =>
        !init?.method || init.method === 'GET'
          ? { ok: true, status: 200, json: async () => existingComments }
          : { ok: true, status: init.method === 'POST' ? 201 : 200, json: async () => ({}) },
      );
    }

    const mutations = (f: ReturnType<typeof vi.fn>) =>
      f.mock.calls.filter((c) => c[1]?.method === 'POST' || c[1]?.method === 'PATCH');

    it('labels findings against the previous comment and embeds a fresh fingerprint block', async () => {
      stubPrContext();
      // previous run reported fingerprints X (still failing? no — unknown) and Y
      const fetchImpl = ghFetch([
        {
          id: 11,
          body: '<!-- playwright-ai-triage -->\nold\n<!-- playwright-ai-triage:fps:v1 aaaaaaaaaaaa bbbbbbbbbbbb -->',
        },
      ]);
      const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
      await run(reporter, [[fakeTest('a'), failedResult()]]);
      const patch = mutations(fetchImpl).find((c) => c[1]?.method === 'PATCH');
      expect(patch).toBeDefined();
      const body = JSON.parse(patch![1].body).body as string;
      expect(body).toContain('🆕'); // current failure not in previous set
      expect(body).toContain('2 failure(s) resolved since the last run');
      expect(body).toMatch(/<!-- playwright-ai-triage:fps:v1 [0-9a-f]{12} -->/);
    });

    it('marks a persisting failure without re-announcing it', async () => {
      stubPrContext();
      // seed: post once with no previous comment to learn the real fingerprint
      const seed = ghFetch([]);
      const r1 = new AiTriageReporter({}, { client: okClient(), fetchImpl: seed });
      await run(r1, [[fakeTest('a'), failedResult()]]);
      const seeded = JSON.parse(mutations(seed)[0]![1].body).body as string;
      const fp = seeded.match(/:fps:v1 ([0-9a-f]{12}) -->/)![1];

      const fetchImpl = ghFetch([{ id: 11, body: seeded }]);
      const r2 = new AiTriageReporter({}, { client: okClient(), fetchImpl });
      await run(r2, [[fakeTest('a'), failedResult()]]);
      const body = JSON.parse(mutations(fetchImpl)[0]![1].body).body as string;
      expect(body).toContain('⏳');
      expect(body).not.toContain('🆕');
      expect(body).not.toContain('resolved since the last run');
      expect(body).toContain(fp); // identity is stable across the two runs
    });

    it('renders unlabeled when the previous comment predates fingerprint blocks', async () => {
      stubPrContext();
      const fetchImpl = ghFetch([{ id: 11, body: '<!-- playwright-ai-triage -->\nold summary' }]);
      const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
      await run(reporter, [[fakeTest('a'), failedResult()]]);
      const body = JSON.parse(mutations(fetchImpl)[0]![1].body).body as string;
      expect(body).not.toContain('🆕');
      expect(body).not.toContain('⏳');
      expect(body).toMatch(/:fps:v1 [0-9a-f]{12} -->/); // new state block still embedded
    });

    it('flips the previous red comment to all-clear on a green run (R1)', async () => {
      stubPrContext();
      const fetchImpl = ghFetch([
        {
          id: 11,
          body: '<!-- playwright-ai-triage -->\nred\n<!-- playwright-ai-triage:fps:v1 aaaaaaaaaaaa bbbbbbbbbbbb cccccccccccc -->',
        },
      ]);
      const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
      const returned = await run(reporter, []);
      expect(returned).toBeUndefined();
      const patch = mutations(fetchImpl).find((c) => c[1]?.method === 'PATCH');
      expect(patch![0]).toContain('/issues/comments/11');
      const body = JSON.parse(patch![1].body).body as string;
      expect(body).toContain('all clear ✅');
      expect(body).toContain('3 previously reported failure(s) resolved');
      expect(body).toContain('<!-- playwright-ai-triage:fps:v1 -->'); // empty state block
      expect(mutations(fetchImpl).some((c) => c[1]?.method === 'POST')).toBe(false);
    });

    it('green run with no previous comment performs no comment mutation (zero-noise)', async () => {
      stubPrContext();
      const fetchImpl = ghFetch([{ id: 1, body: 'someone else' }]);
      const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
      await run(reporter, []);
      expect(mutations(fetchImpl)).toHaveLength(0);
    });

    it('green run with an already-all-clear comment is idempotent (no rewrite)', async () => {
      stubPrContext();
      const fetchImpl = ghFetch([
        {
          id: 11,
          body: '<!-- playwright-ai-triage -->\nall clear ✅\n<!-- playwright-ai-triage:fps:v1 -->',
        },
      ]);
      const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
      await run(reporter, []);
      expect(mutations(fetchImpl)).toHaveLength(0);
    });

    it('keyless green run never touches the GitHub API', async () => {
      stubPrContext();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      const fetchImpl = vi.fn();
      const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
      await run(reporter, []);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('a failing comment lookup on a green run never affects the build', async () => {
      stubPrContext();
      const fetchImpl = vi.fn(async () => {
        throw new Error('ENOTFOUND api.github.com');
      });
      const reporter = new AiTriageReporter({}, { client: okClient(), fetchImpl });
      const returned = await run(reporter, []);
      expect(returned).toBeUndefined();
    });
  });
});
