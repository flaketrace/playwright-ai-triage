import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendOrUpdateRecord,
  groundTruthRecordSchema,
  readDataset,
  writeDataset,
  type GroundTruthRecord,
} from '../src/groundTruth.js';
import type { FailurePayload } from '../src/types.js';

const payload: FailurePayload = {
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

const record = (overrides: Partial<GroundTruthRecord> = {}): GroundTruthRecord => ({
  fingerprint: 'fp1',
  payload,
  humanClass: 'REAL_BUG',
  predictedClass: 'REAL_BUG',
  predictedConfidence: 0.9,
  labeledAt: '2026-08-09T00:00:00.000Z',
  ...overrides,
});

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-triage-gt-'));
  path = join(dir, 'dataset.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readDataset', () => {
  it('returns an empty array when the file does not exist', () => {
    expect(readDataset(path)).toEqual([]);
  });

  it('parses one record per line', () => {
    writeDataset(path, [record({ fingerprint: 'a' }), record({ fingerprint: 'b' })]);
    const records = readDataset(path);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.fingerprint)).toEqual(['a', 'b']);
  });

  it('throws with a line number on malformed JSON rather than silently skipping', () => {
    writeDataset(path, [record({ fingerprint: 'a' })]);
    appendBadLine(path);
    expect(() => readDataset(path)).toThrow(/line 2/);
  });

  it('throws when a line fails schema validation', () => {
    writeDataset(path, [record({ fingerprint: 'a' })]);
    appendBadLine(path, '{"fingerprint":"b"}'); // missing required fields
    expect(() => readDataset(path)).toThrow(/line 2/);
  });
});

function appendBadLine(p: string, badLine = '{not json') {
  appendFileSync(p, `${badLine}\n`);
}

describe('appendOrUpdateRecord', () => {
  it('appends a new record by fingerprint', () => {
    appendOrUpdateRecord(path, record({ fingerprint: 'a' }));
    appendOrUpdateRecord(path, record({ fingerprint: 'b' }));
    expect(readDataset(path).map((r) => r.fingerprint)).toEqual(['a', 'b']);
  });

  it('updates (last-write-wins) rather than duplicating an existing fingerprint', () => {
    appendOrUpdateRecord(path, record({ fingerprint: 'a', humanClass: 'REAL_BUG' }));
    appendOrUpdateRecord(path, record({ fingerprint: 'a', humanClass: 'FLAKY' }));
    const records = readDataset(path);
    expect(records).toHaveLength(1);
    expect(records[0]!.humanClass).toBe('FLAKY');
  });
});

describe('groundTruthRecordSchema', () => {
  it('accepts a full valid record including optional payload fields', () => {
    const withOptionals = record({
      payload: { ...payload, domSnippet: 'x', diffSummary: 'y', timeoutMs: 30000 },
    });
    expect(groundTruthRecordSchema.safeParse(withOptionals).success).toBe(true);
  });

  it('rejects an invalid humanClass', () => {
    const bad = { ...record(), humanClass: 'NOT_A_CLASS' };
    expect(groundTruthRecordSchema.safeParse(bad).success).toBe(false);
  });
});
