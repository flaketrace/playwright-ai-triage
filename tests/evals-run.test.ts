import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClassifierClient } from '../src/classify.js';
import { runGoldenEval } from '../evals/run.js';
import type { GoldenCase } from '../evals/schema.js';
import type { FailurePayload } from '../src/types.js';

const payload = (id: string): FailurePayload => ({
  testId: id,
  title: `test ${id}`,
  file: 'tests/example.spec.ts',
  line: 1,
  errorMessage: 'expect(received).toBe(expected)',
  stack: '',
  retries: [{ attempt: 0, status: 'failed' }],
  retryThenPassed: false,
  duration: 100,
});

const goldenCase = (id: string, humanClass: GoldenCase['humanClass']): GoldenCase => ({
  id,
  payload: payload(id),
  humanClass,
  boundaryType: 'other',
  note: `test fixture ${id}`,
  synthetic: true,
});

function clientAlwaysReturns(
  classOf: (testId: string) => GoldenCase['humanClass'],
): ClassifierClient {
  return {
    messages: {
      parse: async (params: { messages: { content: string }[] }) => {
        const ids = [...params.messages[0]!.content.matchAll(/"testId":\s*"([^"]+)"/g)].map(
          (m) => m[1]!,
        );
        return {
          parsed_output: {
            classifications: ids.map((testId) => ({
              testId,
              class: classOf(testId),
              confidence: 0.9,
              why: 'test',
            })),
          },
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'end_turn',
        };
      },
    },
  } as unknown as ClassifierClient;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evals-run-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runGoldenEval', () => {
  it('returns 2 when ANTHROPIC_API_KEY is unset', async () => {
    const logs: string[] = [];
    const code = await runGoldenEval([], { env: {}, casesDir: dir, errorLog: (m) => logs.push(m) });
    expect(code).toBe(2);
    expect(logs.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('returns 2 when the cases directory has no cases', async () => {
    const logs: string[] = [];
    const code = await runGoldenEval([], {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      casesDir: dir,
      errorLog: (m) => logs.push(m),
    });
    expect(code).toBe(2);
    expect(logs.join(' ')).toMatch(/no golden cases/);
  });

  it('classifies every case and reports 100% accuracy when the judge always agrees', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(goldenCase('a', 'REAL_BUG')));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(goldenCase('b', 'FLAKY')));
    const client = clientAlwaysReturns((id) => (id === 'a' ? 'REAL_BUG' : 'FLAKY'));
    const logs: string[] = [];
    const code = await runGoldenEval(['--draws=1'], {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      casesDir: dir,
      client,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/100\.0%/);
  });

  it('reports per-boundaryType coverage', async () => {
    writeFileSync(
      join(dir, 'a.json'),
      JSON.stringify({ ...goldenCase('a', 'REAL_BUG'), boundaryType: 'flaky-as-real-bug' }),
    );
    writeFileSync(
      join(dir, 'b.json'),
      JSON.stringify({ ...goldenCase('b', 'FLAKY'), boundaryType: 'flaky-as-real-bug' }),
    );
    const client = clientAlwaysReturns(() => 'REAL_BUG');
    const logs: string[] = [];
    const code = await runGoldenEval(['--draws=1', '--json'], {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      casesDir: dir,
      client,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.coverage['flaky-as-real-bug']).toBe(2);
  });

  it('excludes EXAMPLE- prefixed cases from pairs/coverage/accuracy and reports examplesSkipped', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(goldenCase('a', 'REAL_BUG')));
    writeFileSync(
      join(dir, 'example.json'),
      JSON.stringify({
        ...goldenCase('EXAMPLE-flaky-as-real-bug-1', 'FLAKY'),
        boundaryType: 'flaky-as-real-bug',
      }),
    );
    const client = clientAlwaysReturns(() => 'REAL_BUG');
    const logs: string[] = [];
    const code = await runGoldenEval(['--draws=1', '--json'], {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      casesDir: dir,
      client,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.examplesSkipped).toBe(1);
    expect(parsed.coverage['flaky-as-real-bug']).toBeUndefined();
    expect(parsed.accuracy.n).toBe(1);
  });

  it('excludes API-error draws from the confusion matrix and counts an all-errored case as unclassifiable', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(goldenCase('a', 'REAL_BUG')));
    const client = {
      messages: { parse: async () => Promise.reject(new Error('network blip')) },
    } as unknown as ClassifierClient;
    const logs: string[] = [];
    const code = await runGoldenEval(['--draws=1', '--json'], {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      casesDir: dir,
      client,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.unclassifiable).toBe(1);
    expect(parsed.accuracy.value).toBeNull();
  });

  it('emits machine-readable JSON with --json', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(goldenCase('a', 'REAL_BUG')));
    const client = clientAlwaysReturns(() => 'REAL_BUG');
    const logs: string[] = [];
    const code = await runGoldenEval(['--draws=1', '--json'], {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      casesDir: dir,
      client,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.accuracy.value).toBeCloseTo(1, 5);
    expect(parsed.perClass).toHaveLength(5);
  });
});
