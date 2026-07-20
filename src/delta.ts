import type { FailureClass } from './types.js';

/**
 * Cross-run delta (R3) + sticky-class state (R2): the ONLY state is a versioned,
 * invisible HTML comment embedded in the tool's own previous PR comment. No files,
 * no DB — a single previous-run comparison; multi-run history stays out of scope.
 *
 * v2 (ADR-0012) carries `fp:CLASS:confidence` tokens so a PERSISTING failure can
 * reuse its prior classification instead of redrawing it (see ADR-0012). v1
 * blocks (bare fingerprints) still parse — delta works, sticky degrades away.
 *
 * Pure: no IO. Fingerprints come from fingerprint.ts (12 hex chars).
 */

// Trailing space is the version boundary: v20 / v2.1 must NOT parse as v2.
// renderFingerprintBlock always emits it (the empty block is `…:fps:v2 -->`).
const V2_PREFIX = '<!-- playwright-ai-triage:fps:v2 ';
const V1_PREFIX = '<!-- playwright-ai-triage:fps:v1 ';
const FP_TOKEN = /^[0-9a-f]{12}$/;
// Compile-time coupled to FailureClass: adding a class without extending this
// list is a type error — a missing alternation would silently drop the token
// AND its fingerprint, corrupting delta accounting (false NEW / missed RESOLVED).
const CLASSES = [
  'REAL_BUG',
  'FLAKY',
  'SELECTOR_DRIFT',
  'ENV_ISSUE',
  'UNCLASSIFIED',
] as const satisfies readonly FailureClass[];
type CoveredClass = (typeof CLASSES)[number];
type _AllClassesCovered = FailureClass extends CoveredClass ? true : never;
const _allClassesCovered: _AllClassesCovered = true;
void _allClassesCovered;
// Confidence is emitted with toFixed(2); accept 0..1 with up to 2 decimals.
const V2_TOKEN = new RegExp(
  `^([0-9a-f]{12}):(${CLASSES.join('|')}):(0(?:\\.\\d{1,2})?|1(?:\\.0{1,2})?)$`,
);

/** One fingerprint's stored state. `class`/`confidence` are absent for v1 blocks. */
export interface FingerprintEntry {
  fingerprint: string;
  class?: FailureClass;
  confidence?: number;
}

/** Invisible state block appended to every posted comment. Empty list = all clear. */
export function renderFingerprintBlock(entries: FingerprintEntry[]): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const e of entries) {
    if (seen.has(e.fingerprint)) continue; // first entry wins, matching parse order
    seen.add(e.fingerprint);
    // A token the parser would reject must never be emitted: a malformed token is
    // dropped wholesale next run, losing the fingerprint (false NEW / missed
    // RESOLVED). Out-of-range or non-finite confidence degrades to a bare token.
    const confidenceOk =
      e.confidence !== undefined && Number.isFinite(e.confidence)
        ? e.confidence >= 0 && e.confidence <= 1
        : false;
    tokens.push(
      e.class !== undefined && confidenceOk
        ? `${e.fingerprint}:${e.class}:${(e.confidence as number).toFixed(2)} `
        : `${e.fingerprint} `,
    );
  }
  return `${V2_PREFIX}${tokens.join('')}-->`;
}

/**
 * Extract fingerprint entries from a previous comment body. v2 is preferred;
 * a v1 block yields entries without class (delta works, sticky does not).
 * `null` = no parseable block (pre-0.3.0 comment or unknown version) — the
 * caller must treat that as "no delta info", never as "everything resolved".
 * Malformed tokens inside a block are dropped, not fatal.
 */
export function parseFingerprintBlock(body: string): FingerprintEntry[] | null {
  const v2 = extractTokens(body, V2_PREFIX);
  if (v2 !== null) {
    const entries: FingerprintEntry[] = [];
    const seen = new Set<string>();
    for (const token of v2) {
      const match = V2_TOKEN.exec(token);
      let entry: FingerprintEntry | undefined;
      if (match) {
        entry = {
          fingerprint: match[1] as string,
          class: match[2] as FailureClass,
          confidence: Number(match[3]),
        };
      } else if (FP_TOKEN.test(token)) {
        entry = { fingerprint: token }; // tolerated: bare fp inside a v2 block
      }
      if (entry && !seen.has(entry.fingerprint)) {
        seen.add(entry.fingerprint);
        entries.push(entry);
      }
    }
    return entries;
  }

  const v1 = extractTokens(body, V1_PREFIX);
  if (v1 !== null) {
    const seen = new Set<string>();
    const entries: FingerprintEntry[] = [];
    for (const token of v1) {
      if (FP_TOKEN.test(token) && !seen.has(token)) {
        seen.add(token);
        entries.push({ fingerprint: token });
      }
    }
    return entries;
  }

  return null;
}

/** Raw whitespace-split tokens of the first block with `prefix`, or null if absent. */
function extractTokens(body: string, prefix: string): string[] | null {
  const start = body.indexOf(prefix);
  if (start === -1) return null;
  const rest = body.slice(start + prefix.length);
  const end = rest.indexOf('-->');
  if (end === -1) return null;
  return rest.slice(0, end).split(/\s+/).filter(Boolean);
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
