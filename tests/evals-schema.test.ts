import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  goldenCaseSchema,
  readGoldenCases,
  writeGoldenCase,
  type GoldenCase,
} from '../evals/schema.js';
import type { FailurePayload } from '../src/types.js';

const payload = (id: string): FailurePayload => ({
  testId: id,
  title: `test ${id}`,
  file: 'tests/example.spec.ts',
  line: 10,
  errorMessage: 'expect(received).toBe(expected)',
  stack: '',
  retries: [{ attempt: 0, status: 'failed' }],
  retryThenPassed: false,
  duration: 1200,
});

const validCase = (id: string): GoldenCase => ({
  id,
  payload: payload(id),
  humanClass: 'FLAKY',
  boundaryType: 'flaky-as-real-bug',
  note: 'Retried and passed on a later run despite a deterministic-looking assertion failure.',
  synthetic: true,
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evals-schema-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('goldenCaseSchema', () => {
  it('accepts a minimal valid case', () => {
    const result = goldenCaseSchema.safeParse(validCase('a'));
    expect(result.success).toBe(true);
  });

  it('accepts optional historicalFailureRate and screenshots', () => {
    const withExtras = {
      ...validCase('b'),
      historicalFailureRate: { failedInLastNRuns: 3, totalRuns: 20 },
      screenshots: {
        count: 2,
        dimensions: [{ width: 1280, height: 720 }],
        capturedAtOffsetMs: [500, 900],
      },
    };
    expect(goldenCaseSchema.safeParse(withExtras).success).toBe(true);
  });

  it('rejects an unknown boundaryType', () => {
    const bad = { ...validCase('c'), boundaryType: 'not-a-real-category' };
    expect(goldenCaseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a missing note', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { note: _note, ...bad } = validCase('d');
    expect(goldenCaseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty note', () => {
    const bad = { ...validCase('e'), note: '' };
    expect(goldenCaseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a missing synthetic field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { synthetic: _synthetic, ...bad } = validCase('h');
    expect(goldenCaseSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts synthetic: false for a real case', () => {
    const real = { ...validCase('i'), synthetic: false };
    expect(goldenCaseSchema.safeParse(real).success).toBe(true);
  });
});

describe('readGoldenCases', () => {
  it('returns [] for a directory with no case files', () => {
    expect(readGoldenCases(dir)).toEqual([]);
  });

  it('reads and validates every .json file, sorted by filename', () => {
    writeFileSync(join(dir, 'b.json'), JSON.stringify(validCase('b')));
    writeFileSync(join(dir, 'a.json'), JSON.stringify(validCase('a')));
    const cases = readGoldenCases(dir);
    expect(cases.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('ignores non-.json files', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(validCase('a')));
    writeFileSync(join(dir, 'README.md'), '# not a case');
    expect(readGoldenCases(dir).map((c) => c.id)).toEqual(['a']);
  });

  it('throws loud, naming the file, on invalid JSON', () => {
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(() => readGoldenCases(dir)).toThrow(/bad\.json/);
  });

  it('throws loud, naming the file, on schema validation failure', () => {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad' }));
    expect(() => readGoldenCases(dir)).toThrow(/bad\.json/);
  });
});

describe('writeGoldenCase', () => {
  it('writes a case to <dir>/<id>.json and returns the path', () => {
    const path = writeGoldenCase(dir, validCase('f'));
    expect(path).toBe(join(dir, 'f.json'));
    const [written] = readGoldenCases(dir);
    expect(written?.id).toBe('f');
  });

  it('creates the directory if it does not exist', () => {
    const nested = join(dir, 'nested', 'cases');
    writeGoldenCase(nested, validCase('g'));
    expect(readGoldenCases(nested).map((c) => c.id)).toEqual(['g']);
  });
});
