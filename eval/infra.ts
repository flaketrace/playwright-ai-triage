import type { Classification } from '../src/types.js';

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
