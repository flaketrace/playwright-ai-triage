import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runLabel } from '../src/cli/label.js';
import { readDataset, writeDataset } from '../src/groundTruth.js';
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

function envelope(ids: string[]) {
  return JSON.stringify({
    schema: 'ai-triage-sink/v1',
    reporter: 'playwright-ai-triage',
    createdAt: '2026-08-09T00:00:00.000Z',
    run: { shard: null },
    summary: { failures: ids.length, counts: {}, costUsd: 0, model: 'claude-haiku-4-5' },
    failures: ids.map((id) => ({
      fingerprint: id,
      payload: payload(id),
      classification: { class: 'REAL_BUG', confidence: 0.8, why: 'test' },
    })),
  });
}

/** Feeds a fixed sequence of answers to successive ask() calls. */
function scriptedAsk(answers: string[]): () => Promise<string> {
  let i = 0;
  return async () => {
    const answer = answers[i] ?? 'q';
    i += 1;
    return answer;
  };
}

let dir: string;
let datasetPath: string;
let runPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-triage-label-'));
  datasetPath = join(dir, 'dataset.jsonl');
  runPath = join(dir, 'run.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runLabel', () => {
  it('returns 2 when --run is missing', async () => {
    const logs: string[] = [];
    const code = await runLabel([], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath },
      errorLog: (m) => logs.push(m),
    });
    expect(code).toBe(2);
    expect(logs.join(' ')).toMatch(/--run/);
  });

  it('returns 2 when AI_TRIAGE_EVAL_DATASET is unset', async () => {
    const logs: string[] = [];
    const code = await runLabel(['--run', runPath], { env: {}, errorLog: (m) => logs.push(m) });
    expect(code).toBe(2);
    expect(logs.join(' ')).toMatch(/AI_TRIAGE_EVAL_DATASET/);
  });

  it('confirming (y) writes a record with the predicted class as ground truth', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(runPath, envelope(['a']));
    const code = await runLabel(['--run', runPath], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath },
      ask: scriptedAsk(['y']),
      log: () => {},
    });
    expect(code).toBe(0);
    const records = readDataset(datasetPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      fingerprint: 'a',
      humanClass: 'REAL_BUG',
      predictedClass: 'REAL_BUG',
    });
  });

  it('correcting (n + class) writes the human-provided class instead', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(runPath, envelope(['a']));
    const code = await runLabel(['--run', runPath], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath },
      ask: scriptedAsk(['n', 'FLAKY']),
      log: () => {},
    });
    expect(code).toBe(0);
    const records = readDataset(datasetPath);
    expect(records[0]).toMatchObject({ humanClass: 'FLAKY', predictedClass: 'REAL_BUG' });
  });

  it('skip (s) does not write a record', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(runPath, envelope(['a']));
    const code = await runLabel(['--run', runPath], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath },
      ask: scriptedAsk(['s']),
      log: () => {},
    });
    expect(code).toBe(0);
    expect(readDataset(datasetPath)).toHaveLength(0);
  });

  it('quit (q) stops without processing remaining failures', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(runPath, envelope(['a', 'b']));
    const code = await runLabel(['--run', runPath], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath },
      ask: scriptedAsk(['q']),
      log: () => {},
    });
    expect(code).toBe(0);
    expect(readDataset(datasetPath)).toHaveLength(0);
  });

  it('skips fingerprints already present in the dataset', async () => {
    const fs = await import('node:fs');
    fs.writeFileSync(runPath, envelope(['a', 'b']));
    writeDataset(datasetPath, [
      {
        fingerprint: 'a',
        payload: payload('a'),
        humanClass: 'REAL_BUG',
        predictedClass: 'REAL_BUG',
        predictedConfidence: 0.9,
        labeledAt: '2026-08-09T00:00:00.000Z',
      },
    ]);
    const asked: string[] = [];
    const code = await runLabel(['--run', runPath], {
      env: { AI_TRIAGE_EVAL_DATASET: datasetPath },
      ask: async (q) => {
        asked.push(q);
        return 'y';
      },
      log: () => {},
    });
    expect(code).toBe(0);
    // only 'b' should have prompted — 'a' was already labeled
    expect(asked.some((q) => q.includes('"b"') || q.toLowerCase().includes('test b'))).toBe(true);
    expect(readDataset(datasetPath)).toHaveLength(2);
  });
});
