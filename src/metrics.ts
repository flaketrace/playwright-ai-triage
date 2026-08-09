import { FAILURE_CLASSES, type FailureClass } from './types.js';

/** A class with fewer than this many actual (support) or predicted cases
 * is flagged, not hidden — a precision/recall figure on n=1 is technically
 * computable and practically meaningless. */
const LOW_SUPPORT_THRESHOLD = 5;

export interface EvalPair {
  predicted: FailureClass;
  actual: FailureClass;
}

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a proportion — chosen over the naive normal
 * approximation because it stays inside [0,1] and remains sane at small n and
 * at p̂ near 0 or 1, which is exactly the regime a 20-40 case eval lives in.
 *
 * total <= 0 returns the full [0,1] range: zero observations is maximal
 * uncertainty, not an error.
 */
export function wilsonInterval(successes: number, total: number, z = 1.96): Interval {
  if (total <= 0) return { low: 0, high: 1 };
  const phat = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denom;
  const margin =
    (z / denom) * Math.sqrt(phat * (1 - phat) / total + z2 / (4 * total * total));
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export type ConfusionMatrix = Record<FailureClass, Record<FailureClass, number>>;

function emptyMatrix(): ConfusionMatrix {
  const matrix = {} as ConfusionMatrix;
  for (const actual of FAILURE_CLASSES) {
    matrix[actual] = {} as Record<FailureClass, number>;
    for (const predicted of FAILURE_CLASSES) matrix[actual][predicted] = 0;
  }
  return matrix;
}

/** Rows = actual, columns = predicted. All 5 classes present even at zero. */
export function confusionMatrix(pairs: EvalPair[]): ConfusionMatrix {
  const matrix = emptyMatrix();
  for (const { predicted, actual } of pairs) matrix[actual][predicted] += 1;
  return matrix;
}

export interface PerClassMetric {
  class: FailureClass;
  /** count of pairs whose actual class is this one */
  support: number;
  /** count of pairs whose predicted class is this one */
  predictedCount: number;
  truePositives: number;
  /** null when predictedCount is 0 — "no predictions" is not the same as precision 0 */
  precision: number | null;
  precisionCI: Interval | null;
  /** null when support is 0 — "no ground truth" is not the same as recall 0 */
  recall: number | null;
  recallCI: Interval | null;
  f1: number | null;
  /** support or predictedCount below LOW_SUPPORT_THRESHOLD — figure is unreliable */
  lowSupport: boolean;
}

/** The classes are imbalanced (FLAKY vastly outnumbers REAL_BUG in practice) —
 * this reports every class separately rather than one blended accuracy
 * number, which would hide a judge that is only good at the common class. */
export function perClassMetrics(pairs: EvalPair[]): PerClassMetric[] {
  return FAILURE_CLASSES.map((cls) => {
    const support = pairs.filter((p) => p.actual === cls).length;
    const predictedCount = pairs.filter((p) => p.predicted === cls).length;
    const truePositives = pairs.filter((p) => p.actual === cls && p.predicted === cls).length;

    const precision = predictedCount > 0 ? truePositives / predictedCount : null;
    const recall = support > 0 ? truePositives / support : null;
    const f1 =
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : precision !== null && recall !== null
          ? 0
          : null;

    return {
      class: cls,
      support,
      predictedCount,
      truePositives,
      precision,
      precisionCI: predictedCount > 0 ? wilsonInterval(truePositives, predictedCount) : null,
      recall,
      recallCI: support > 0 ? wilsonInterval(truePositives, support) : null,
      f1,
      lowSupport: support < LOW_SUPPORT_THRESHOLD || predictedCount < LOW_SUPPORT_THRESHOLD,
    };
  });
}

export interface AccuracySummary {
  /** null when pairs is empty — an absence of measurement, not zero accuracy */
  value: number | null;
  ci: Interval | null;
  n: number;
}

export function overallAccuracy(pairs: EvalPair[]): AccuracySummary {
  if (pairs.length === 0) return { value: null, ci: null, n: 0 };
  const correct = pairs.filter((p) => p.predicted === p.actual).length;
  return {
    value: correct / pairs.length,
    ci: wilsonInterval(correct, pairs.length),
    n: pairs.length,
  };
}
