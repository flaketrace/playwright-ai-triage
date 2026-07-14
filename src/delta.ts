/**
 * Cross-run delta (R3): the ONLY state is a versioned, invisible HTML comment
 * embedded in the tool's own previous PR comment. No files, no DB — a single
 * previous-run comparison; multi-run history stays out of scope.
 *
 * Pure: no IO. Fingerprints come from fingerprint.ts (12 hex chars).
 */

// Trailing space is the version boundary: v10 / v1.1 must NOT parse as v1.
// renderFingerprintBlock always emits it (the empty block is `…:fps:v1 -->`).
const BLOCK_PREFIX = '<!-- playwright-ai-triage:fps:v1 ';
const FP_TOKEN = /^[0-9a-f]{12}$/;

/** Invisible state block appended to every posted comment. Empty list = all clear. */
export function renderFingerprintBlock(fingerprints: string[]): string {
  const unique = [...new Set(fingerprints)];
  return `${BLOCK_PREFIX}${unique.map((f) => `${f} `).join('')}-->`;
}

/**
 * Extract fingerprints from a previous comment body.
 * `null` = no parseable v1 block (pre-0.3.0 comment or unknown version) — the
 * caller must treat that as "no delta info", never as "everything resolved".
 * Malformed tokens inside a v1 block are dropped, not fatal.
 */
export function parseFingerprintBlock(body: string): string[] | null {
  const start = body.indexOf(BLOCK_PREFIX);
  if (start === -1) return null;
  const rest = body.slice(start + BLOCK_PREFIX.length);
  const end = rest.indexOf('-->');
  if (end === -1) return null;
  const tokens = rest
    .slice(0, end)
    .split(/\s+/)
    .filter((t) => FP_TOKEN.test(t));
  return [...new Set(tokens)];
}

export interface Delta {
  /** fingerprint → label for every currently failing fingerprint */
  labels: Map<string, 'new' | 'persisting'>;
  /** fingerprints present in the previous run and absent now */
  resolvedCount: number;
}

/** Diff current failures against the previous block. `previous === null` ⇒ null (no labels). */
export function computeDelta(current: string[], previous: string[] | null): Delta | null {
  if (previous === null) return null;
  const prev = new Set(previous);
  const cur = new Set(current);
  const labels = new Map<string, 'new' | 'persisting'>();
  for (const fp of cur) labels.set(fp, prev.has(fp) ? 'persisting' : 'new');
  let resolvedCount = 0;
  for (const fp of prev) if (!cur.has(fp)) resolvedCount += 1;
  return { labels, resolvedCount };
}
