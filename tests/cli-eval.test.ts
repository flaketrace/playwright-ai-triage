import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runEval } from '../src/cli/eval.js';
import type { ClassifierClient } from '../src/classify.js';
import { writeDataset, type GroundTruthRecord } from '../src/groundTruth.js';
import type { FailurePayload } from '../src/types.js';

const payload = (id: string): FailurePayload => ({
  testId: id,
  title: `test ${id}`,
  file: '/repo/t.spec.ts',
  line: 1,
  errorMessage: 'expect(received).toBe(expected)',
  stack: '',
  retries: [{ attempt: 0, status: 'failed' }],
  retryThenPassed: false,
  duration: 100,
});

const record = (id: string, humanClass: GroundTruthRecord['humanClass']): GroundTruthRecord => ({
  fingerprint: id,
  payload: payload(id),
  humanClass,
  predictedClass: humanClass,
  predictedConfidence: 0.8,
  labeledAt: '2026-08-09T00:00:00.000Z',
});

/** Always answers with the class matching the payload's own testId prefix,
 * so the eval can be steered deterministically per test. */
function clientAlwaysReturns(
  classOf: (testId: string) => GroundTruthRecord['humanClass'],
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
let datasetPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-triage-eval-'));
  datasetPath = join(dir, 'dataset.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runEval', () => {
  it('returns 2 when AI_TRIAGE_EVAL_DATASET is unset', async () => {
    const logs: string[] = [];
    const code = await runEval([], { env: {}, errorLog: (m) => logs.push(m) });
    expect(code).toBe(2);
    expect(logs.join(' ')).toMatch(/AI_TRIAGE_EVAL_DATASET/);
  });

  it('returns 2 when ANTHROPIC_API_KEY is unset', async () => {
    writeDataset(datasetPath, [record('a', 'REAL_BUG')]);
    const logs: string[] = [];
    const code = await runEval([], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath },
      errorLog: (m) => logs.push(m),
    });
    expect(code).toBe(2);
    expect(logs.join(' ')).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('returns 2 for an empty dataset', async () => {
    writeDataset(datasetPath, []);
    const logs: string[] = [];
    const code = await runEval([], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath, ANTHROPIC_API_KEY: 'sk-test' },
      errorLog: (m) => logs.push(m),
    });
    expect(code).toBe(2);
    expect(logs.join(' ')).toMatch(/empty/);
  });

  it('re-classifies every case and reports 100% accuracy when the judge always agrees', async () => {
    writeDataset(datasetPath, [record('a', 'REAL_BUG'), record('b', 'FLAKY')]);
    const client = clientAlwaysReturns((id) => (id === 'a' ? 'REAL_BUG' : 'FLAKY'));
    const logs: string[] = [];
    const code = await runEval(['--draws=1'], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath, ANTHROPIC_API_KEY: 'sk-test' },
      client,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/100\.0%/);
  });

  it('reports lower accuracy when the judge disagrees with ground truth', async () => {
    writeDataset(datasetPath, [record('a', 'REAL_BUG'), record('b', 'FLAKY')]);
    const client = clientAlwaysReturns(() => 'ENV_ISSUE');
    const logs: string[] = [];
    const code = await runEval(['--draws=1'], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath, ANTHROPIC_API_KEY: 'sk-test' },
      client,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/0\.0%/);
  });

  it('emits machine-readable JSON with --json', async () => {
    writeDataset(datasetPath, [record('a', 'REAL_BUG')]);
    const client = clientAlwaysReturns(() => 'REAL_BUG');
    const logs: string[] = [];
    const code = await runEval(['--draws=1', '--json'], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath, ANTHROPIC_API_KEY: 'sk-test' },
      client,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.accuracy.value).toBeCloseTo(1, 5);
    expect(parsed.perClass).toHaveLength(5);
  });
});
