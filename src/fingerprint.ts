import { createHash } from 'node:crypto';

/**
 * Failure fingerprint (R2): a short stable identity for "the same failure" —
 * same test + same error shape ⇒ same id, across runs. Used for cross-run
 * delta labeling (NEW / PERSISTING / RESOLVED), dogfood-log identity, and
 * calibration tracking (identical fingerprints should classify identically).
 *
 * Pure: no IO, no clock, no randomness.
 */

/** Head of the message only: type + matcher + locator live in the first lines;
 * call-log tails carry retry counts and timing jitter. */
const HEAD_LINES = 3;
const HEAD_MAX_CHARS = 240;

// Masking order matters: timestamps/UUIDs/hex/query would be half-eaten if the
// bare-number pass ran first. HEX_RUN requires at least one a–f letter so that
// pure-digit runs (epoch millis, big counters) mask as <n>, not <hex> — a value
// crossing a digit-count threshold between runs must not flip its token.
const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RUN =
  /(?<![0-9a-z])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}(?![0-9a-z])|(?<=[a-z])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}(?![0-9a-z])/gi;
const URL_QUERY = /\?[^\s"'`)]+/g;
const NUMBER_RUN = /\d+(?:\.\d+)?/g;

/** Error message reduced to its stable shape (volatile parts masked). */
export function normalizeErrorSignature(errorMessage: string): string {
  const head = errorMessage
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, HEAD_LINES)
    .join(' ');

  // Mask BEFORE capping: volatile values become fixed-width tokens first, so a
  // longer timeout or id can never shift the 240-char cut point and split one
  // failure shape into two fingerprints.
  return head
    .replace(ISO_TS, '<ts>')
    .replace(UUID, '<uuid>')
    .replace(HEX_RUN, '<hex>')
    .replace(URL_QUERY, '?<q>')
    .replace(NUMBER_RUN, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, HEAD_MAX_CHARS);
}

/** Deterministic identity for a failure: sha256(testId + normalized error head).
 * 12 hex chars = 48 bits — collisions become likely only around ~16M distinct
 * failures, far beyond any single repo's failure cardinality, while staying
 * short enough to read in a comment block and a log line. */
export function failureFingerprint(p: { testId: string; errorMessage: string }): string {
  return createHash('sha256')
    .update(`${p.testId}\n${normalizeErrorSignature(p.errorMessage)}`)
    .digest('hex')
    .slice(0, 12);
}
