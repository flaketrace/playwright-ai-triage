import type { Classification } from '../src/types.js';

/**
 * Collapse N draws of the same fixture into one graded verdict plus the
 * agreement behind it (§14.2b).
 *
 * Classification is a draw from a distribution — sampling parameters are not
 * configurable on current-generation models — so a single-draw eval reports a
 * point estimate whose variance it cannot see. Grading the majority and
 * reporting `agreeing/total` makes an unstable fixture visible even when the
 * accuracy column looks perfect.
 *
 * Pure: no IO, no clock, no randomness.
 */
export interface DrawSummary {
  /** the graded verdict: modal class, confidence averaged over the majority draws */
  classification: Classification;
  /** how many draws returned the modal class */
  agreeing: number;
  total: number;
  /** true when the draws did not all agree — the accuracy figure is a majority, not a fact */
  unstable: boolean;
  /**
   * true when the top class does not lead outright — its count is shared with a
   * runner-up (1-1, 1-1-1, 2-2-1). NOTE this is a shared-top test, not a
   * strict-majority test: a 2-1-1-1 plurality has no majority yet is graded on
   * its modal class, which is what the harness asks for. The fixture
   * is INDETERMINATE: picking the first-seen class would decide pass/fail — and
   * the process exit code — by which draw happened to return first, which is the
   * exact coin-flip this measurement exists to expose. Callers must not grade it.
   */
  tied: boolean;
}

export function summarizeDraws(draws: Classification[]): DrawSummary | undefined {
  if (draws.length === 0) return undefined;

  const counts = new Map<Classification['class'], number>();
  for (const draw of draws) counts.set(draw.class, (counts.get(draw.class) ?? 0) + 1);

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topClass, agreeing] = ranked[0]!;
  // A shared top count is a tie. `classification` is still populated (the
  // first-seen class, for display), but `tied` tells the caller not to grade it.
  const tied = ranked.length > 1 && ranked[1]![1] === agreeing;
  const majority = draws.filter((d) => d.class === topClass);

  return {
    classification: {
      ...majority[0]!,
      confidence: majority.reduce((sum, d) => sum + d.confidence, 0) / majority.length,
    },
    agreeing,
    total: draws.length,
    unstable: agreeing < draws.length,
    tied,
  };
}
