import type { Classification, FailurePayload } from './types.js';
import { classifyFailures, type ClassifierClient } from './classify.js';
import type { ResolvedConfig } from './config.js';

// Note text emitted by classifyFailures when infrastructure (not judgment)
// produced the result. String-coupled to src/classify.ts on purpose — the
// tests in tests/eval-smoke.test.ts pin the coupling.
const INFRA_NOTE = /API error|ANTHROPIC_API_KEY|refusal|max_tokens|maxFailures cap/;

// The `why` strings classifyFailures stamps on fail-closed UNCLASSIFIED
// results it produced itself. A model-chosen UNCLASSIFIED carries the model's
// own free-text why and never matches these.
const SENTINEL_WHY =
  /^(no schema-valid classification returned|classifier (API error|refusal|max_tokens)|no API key available|beyond the maxFailures budget cap)$/;

/**
 * Distinguish "the model judged this" from "infrastructure got in the way".
 * Returns a human-readable reason when the result must NOT be graded, or
 * undefined when it is a legitimate model verdict.
 */
export function infraReason(
  notes: string[],
  classification: Classification | undefined,
): string | undefined {
  const note = notes.find((n) => INFRA_NOTE.test(n));
  if (note) return note;
  if (!classification) return 'no classification entry returned';
  if (SENTINEL_WHY.test(classification.why)) return `sentinel result: ${classification.why}`;
  return undefined;
}

/**
 * Collapse N draws of the same payload into one graded verdict plus the
 * agreement behind it.
 *
 * Classification is a draw from a distribution — sampling parameters are not
 * configurable on current-generation models — so a single-draw call reports a
 * point estimate whose variance it cannot see. Grading the majority and
 * reporting `agreeing/total` makes an unstable case visible even when a
 * single-shot accuracy figure looks perfect. This is the self-consistency
 * confidence signal used in place of the model's self-reported confidence,
 * which is known to be poorly calibrated.
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
   * its modal class, which is what callers ask for. A tied case is
   * INDETERMINATE: picking the first-seen class would decide pass/fail by
   * which draw happened to return first, which is the exact coin-flip this
   * measurement exists to expose. Callers must not grade it.
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

export interface SelfConsistencyResult {
  summary: DrawSummary;
  costUsd: number;
  /** draws excluded because they were infra failures, not real judge verdicts */
  erroredDraws: number;
}

/**
 * Classify one payload `draws` times independently (one API call per draw —
 * isolation: one bad call can't corrupt the others) and collapse the result
 * via summarizeDraws. A draw whose classification is infrastructure-caused
 * (API error, missing key, refusal, max_tokens, etc. — see `infraReason`) is
 * excluded from the collapsed verdict: it is not a real judge draw, and
 * accepting it would blend transport/API reliability into the judge accuracy
 * this function exists to measure. Returns undefined when zero draws
 * produced a real classification at all (e.g. every call errored) — there is
 * no verdict to report, fabricated or otherwise.
 */
export async function classifyWithSelfConsistency(
  payload: FailurePayload,
  config: ResolvedConfig,
  draws: number,
  deps: { client?: ClassifierClient } = {},
): Promise<SelfConsistencyResult | undefined> {
  const collected: Classification[] = [];
  let costUsd = 0;
  let erroredDraws = 0;
  for (let i = 0; i < draws; i += 1) {
    const result = await classifyFailures([payload], config, deps);
    const classification = result.classified[0]?.classification;
    if (infraReason(result.notes, classification)) {
      erroredDraws += 1;
    } else if (classification) {
      collected.push(classification);
    }
    costUsd += result.costUsd ?? 0;
  }
  const summary = summarizeDraws(collected);
  if (!summary) return undefined;
  return { summary, costUsd, erroredDraws };
}
