import { describe, expect, it } from 'vitest';

import { summarizeDraws } from '../src/reliability.js';
import type { Classification } from '../src/types.js';

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
