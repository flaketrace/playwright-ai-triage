/**
 * The smoke-eval's TERMINATING verdict, as a pure decision (§14.2b).
 *
 * Not the whole exit contract: the runner also exits 2 (missing key) and 3
 * (infra abort) directly, before grading is possible. This covers only the
 * codes reachable once a graded table exists, so the union below is not the
 * exhaustive set of the harness's exit codes.
 *
 *   0 — every gradeable fixture was class-accurate, nothing indeterminate
 *   1 — at least one gradeable fixture missed its acceptable classes
 *   4 — no gradeable fixture missed, but ≥1 was INDETERMINATE (tied draws:
 *       measurement absent, not a regression). Includes the all-tied case,
 *       where nothing was graded at all — vacuously "no misses", still 4.
 *
 * Accuracy is judged over GRADEABLE fixtures only. Judging it over all rows
 * folds ties into the failure condition — which silently made exit 4
 * unreachable when this logic lived inline and untested in the runner.
 *
 * Precedence: a real miss (1) outranks indeterminacy (4), so a prompt
 * regression can never be masked by a tie elsewhere in the table.
 *
 * Pure: no IO, no clock, no randomness.
 */
export type EvalExitCode = 0 | 1 | 4;

export function evalExitCode(counts: {
  /** gradeable fixtures whose class was acceptable */
  passed: number;
  /** fixtures that produced a gradeable verdict (total minus tied) */
  gradeable: number;
  /** fixtures with no outright modal class */
  tiedCount: number;
}): EvalExitCode {
  if (counts.passed < counts.gradeable) return 1;
  if (counts.tiedCount > 0) return 4;
  return 0;
}
