import { describe, expect, it } from 'vitest';

import {
  confusionMatrix,
  overallAccuracy,
  perClassMetrics,
  wilsonInterval,
  type EvalPair,
} from '../src/metrics.js';

describe('wilsonInterval', () => {
  it('matches the textbook n=20, x=10 (p̂=0.5) 95% interval', () => {
    const { low, high } = wilsonInterval(10, 20);
    expect(low).toBeCloseTo(0.299, 2);
    expect(high).toBeCloseTo(0.701, 2);
  });

  it('is symmetric around 0.5 when successes is half of total', () => {
    const { low, high } = wilsonInterval(50, 100);
    expect(low + high).toBeCloseTo(1, 5);
  });

  it('returns the full [0,1] range for zero total — maximal uncertainty', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('the interval always contains the point estimate and stays within [0,1]', () => {
    const { low, high } = wilsonInterval(3, 5);
    const phat = 3 / 5;
    expect(low).toBeLessThanOrEqual(phat);
    expect(high).toBeGreaterThanOrEqual(phat);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });
});

const p = (predicted: EvalPair['predicted'], actual: EvalPair['actual']): EvalPair => ({
  predicted,
  actual,
});

// 5 pairs: REAL_BUG correctly predicted twice, once mispredicted as FLAKY;
// FLAKY correctly predicted once, once mispredicted as REAL_BUG.
const PAIRS: EvalPair[] = [
  p('REAL_BUG', 'REAL_BUG'),
  p('REAL_BUG', 'REAL_BUG'),
  p('REAL_BUG', 'FLAKY'),
  p('FLAKY', 'FLAKY'),
  p('FLAKY', 'REAL_BUG'),
];

describe('confusionMatrix', () => {
  it('rows are actual, columns are predicted, all 5 classes present', () => {
    const m = confusionMatrix(PAIRS);
    expect(m.REAL_BUG).toEqual({
      REAL_BUG: 2,
      FLAKY: 1,
      SELECTOR_DRIFT: 0,
      ENV_ISSUE: 0,
      UNCLASSIFIED: 0,
    });
    expect(m.FLAKY).toEqual({
      REAL_BUG: 1,
      FLAKY: 1,
      SELECTOR_DRIFT: 0,
      ENV_ISSUE: 0,
      UNCLASSIFIED: 0,
    });
    expect(m.SELECTOR_DRIFT.REAL_BUG).toBe(0);
  });
});

describe('perClassMetrics', () => {
  it('computes precision/recall/f1/support for classes with data', () => {
    const metrics = perClassMetrics(PAIRS);
    const realBug = metrics.find((m) => m.class === 'REAL_BUG')!;
    expect(realBug.support).toBe(3);
    expect(realBug.predictedCount).toBe(3);
    expect(realBug.truePositives).toBe(2);
    expect(realBug.precision).toBeCloseTo(2 / 3, 5);
    expect(realBug.recall).toBeCloseTo(2 / 3, 5);
    expect(realBug.f1).toBeCloseTo(2 / 3, 5);
    expect(realBug.lowSupport).toBe(true); // support 3 < threshold 5

    const flaky = metrics.find((m) => m.class === 'FLAKY')!;
    expect(flaky.precision).toBeCloseTo(0.5, 5);
    expect(flaky.recall).toBeCloseTo(0.5, 5);
  });

  it('reports null precision/recall/f1 for classes with no support and no predictions', () => {
    const metrics = perClassMetrics(PAIRS);
    const drift = metrics.find((m) => m.class === 'SELECTOR_DRIFT')!;
    expect(drift.support).toBe(0);
    expect(drift.predictedCount).toBe(0);
    expect(drift.precision).toBeNull();
    expect(drift.recall).toBeNull();
    expect(drift.f1).toBeNull();
    expect(drift.lowSupport).toBe(true);
  });

  it('returns all 5 classes even when pairs is empty', () => {
    expect(perClassMetrics([])).toHaveLength(5);
  });
});

describe('overallAccuracy', () => {
  it('computes accuracy and a Wilson CI over the pair count', () => {
    const acc = overallAccuracy(PAIRS);
    expect(acc.value).toBeCloseTo(3 / 5, 5);
    expect(acc.n).toBe(5);
    expect(acc.ci).not.toBeNull();
    expect(acc.ci!.low).toBeLessThanOrEqual(acc.value!);
    expect(acc.ci!.high).toBeGreaterThanOrEqual(acc.value!);
  });

  it('reports null value/ci for an empty pair set — not zero, an absence of measurement', () => {
    const acc = overallAccuracy([]);
    expect(acc.value).toBeNull();
    expect(acc.ci).toBeNull();
    expect(acc.n).toBe(0);
  });
});
