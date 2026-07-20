import { describe, expect, it } from 'vitest';

import {
  computeDelta,
  parseFingerprintBlock,
  renderFingerprintBlock,
  type FingerprintEntry,
} from '../src/delta.js';

const FP_A = '3f9a1c2b4d5e';
const FP_B = '90ab12cd34ef';
const FP_C = 'deadbeef0123';

const entry = (
  fingerprint: string,
  cls?: FingerprintEntry['class'],
  confidence?: number,
): FingerprintEntry => ({
  fingerprint,
  ...(cls ? { class: cls } : {}),
  ...(confidence !== undefined ? { confidence } : {}),
});

describe('renderFingerprintBlock / parseFingerprintBlock (v2)', () => {
  it('round-trips entries with class and confidence', () => {
    const block = renderFingerprintBlock([
      entry(FP_A, 'REAL_BUG', 0.75),
      entry(FP_B, 'ENV_ISSUE', 0.9),
    ]);
    expect(parseFingerprintBlock(`<!-- playwright-ai-triage -->\nbody\n${block}`)).toEqual([
      entry(FP_A, 'REAL_BUG', 0.75),
      entry(FP_B, 'ENV_ISSUE', 0.9),
    ]);
  });

  it('renders an empty block and parses it back to []', () => {
    expect(parseFingerprintBlock(renderFingerprintBlock([]))).toEqual([]);
  });

  it('round-trips a class-less entry as a bare fingerprint token', () => {
    const block = renderFingerprintBlock([entry(FP_A)]);
    expect(parseFingerprintBlock(block)).toEqual([entry(FP_A)]);
  });

  it('degrades out-of-range or non-finite confidence to a bare fingerprint token', () => {
    const block = renderFingerprintBlock([
      entry(FP_A, 'REAL_BUG', 1.5),
      entry(FP_B, 'FLAKY', Number.NaN),
    ]);
    expect(parseFingerprintBlock(block)).toEqual([entry(FP_A), entry(FP_B)]);
  });

  it('dedupes by fingerprint keeping the first entry', () => {
    const block = renderFingerprintBlock([
      entry(FP_A, 'REAL_BUG', 0.75),
      entry(FP_A, 'FLAKY', 0.5),
      entry(FP_B, 'ENV_ISSUE', 0.8),
    ]);
    expect(parseFingerprintBlock(block)).toEqual([
      entry(FP_A, 'REAL_BUG', 0.75),
      entry(FP_B, 'ENV_ISSUE', 0.8),
    ]);
  });

  it('parses a v1 block as entries without class (upgrade path: delta works, sticky does not)', () => {
    const v1 = `<!-- playwright-ai-triage:fps:v1 ${FP_A} ${FP_B} -->`;
    expect(parseFingerprintBlock(`summary\n${v1}`)).toEqual([entry(FP_A), entry(FP_B)]);
  });

  it('returns null when no block is present (pre-0.3.0 comment)', () => {
    expect(parseFingerprintBlock('<!-- playwright-ai-triage -->\nold summary')).toBeNull();
  });

  it('returns null for an unknown block version', () => {
    expect(
      parseFingerprintBlock(`<!-- playwright-ai-triage:fps:v3 ${FP_A}:REAL_BUG:0.75 -->`),
    ).toBeNull();
  });

  it('does not parse future versions sharing a prefix (v10, v1.1, v20, v2.1)', () => {
    expect(parseFingerprintBlock(`<!-- playwright-ai-triage:fps:v10 ${FP_A} -->`)).toBeNull();
    expect(parseFingerprintBlock(`<!-- playwright-ai-triage:fps:v1.1 ${FP_A} -->`)).toBeNull();
    expect(
      parseFingerprintBlock(`<!-- playwright-ai-triage:fps:v20 ${FP_A}:REAL_BUG:0.75 -->`),
    ).toBeNull();
    expect(
      parseFingerprintBlock(`<!-- playwright-ai-triage:fps:v2.1 ${FP_A}:REAL_BUG:0.75 -->`),
    ).toBeNull();
  });

  it('drops malformed v2 tokens instead of failing the whole block', () => {
    const body = [
      `<!-- playwright-ai-triage:fps:v2 ${FP_A}:REAL_BUG:0.75`,
      'not-a-fp',
      `${FP_B}:NOT_A_CLASS:0.5`,
      `${FP_B}:REAL_BUG:1.5`,
      `${FP_C}:FLAKY:0.9`,
      '-->',
    ].join(' ');
    expect(parseFingerprintBlock(body)).toEqual([
      entry(FP_A, 'REAL_BUG', 0.75),
      entry(FP_C, 'FLAKY', 0.9),
    ]);
  });

  it('is invisible-comment shaped (starts <!--, ends -->, single line)', () => {
    const block = renderFingerprintBlock([entry(FP_A, 'REAL_BUG', 0.75)]);
    expect(block).toMatch(/^<!-- playwright-ai-triage:fps:v2 \S.*-->$/);
    expect(block).not.toContain('\n');
  });

  it('prefers the v2 block when both v2 and v1 blocks are present in the body', () => {
    // Defensive: only one block is ever written, but the parser must be deterministic —
    // v2 is preferred when present.
    const v2 = renderFingerprintBlock([entry(FP_A, 'REAL_BUG', 0.75)]);
    const body = `summary\n${v2}\n<!-- playwright-ai-triage:fps:v1 ${FP_B} -->`;
    expect(parseFingerprintBlock(body)).toEqual([entry(FP_A, 'REAL_BUG', 0.75)]);
  });
});

describe('computeDelta', () => {
  it('returns null when there is no previous block (no delta info ≠ everything resolved)', () => {
    expect(computeDelta([FP_A], null)).toBeNull();
  });

  it('labels everything new against an empty previous block (previous run was all clear)', () => {
    const d = computeDelta([FP_A, FP_B], [])!;
    expect(d.labels.get(FP_A)).toBe('new');
    expect(d.labels.get(FP_B)).toBe('new');
    expect(d.resolvedCount).toBe(0);
  });

  it('splits mixed sets into new / persisting / resolved', () => {
    const d = computeDelta([FP_A, FP_B], [FP_B, FP_C])!;
    expect(d.labels.get(FP_A)).toBe('new');
    expect(d.labels.get(FP_B)).toBe('persisting');
    expect(d.resolvedCount).toBe(1);
  });

  it('all resolved on a fully green delta', () => {
    const d = computeDelta([], [FP_A, FP_B])!;
    expect(d.labels.size).toBe(0);
    expect(d.resolvedCount).toBe(2);
  });

  it('dedupes duplicate fingerprints on both sides', () => {
    const d = computeDelta([FP_A, FP_A], [FP_A, FP_A, FP_C, FP_C])!;
    expect(d.labels.get(FP_A)).toBe('persisting');
    expect(d.resolvedCount).toBe(1);
  });
});
