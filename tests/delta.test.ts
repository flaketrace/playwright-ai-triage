import { describe, expect, it } from 'vitest';

import { computeDelta, parseFingerprintBlock, renderFingerprintBlock } from '../src/delta.js';

const FP_A = '3f9a1c2b4d5e';
const FP_B = '90ab12cd34ef';
const FP_C = 'deadbeef0123';

describe('renderFingerprintBlock / parseFingerprintBlock', () => {
  it('round-trips a fingerprint list', () => {
    const block = renderFingerprintBlock([FP_A, FP_B]);
    expect(parseFingerprintBlock(`<!-- playwright-ai-triage -->\nbody\n${block}`)).toEqual([
      FP_A,
      FP_B,
    ]);
  });

  it('renders an empty block and parses it back to []', () => {
    const block = renderFingerprintBlock([]);
    expect(parseFingerprintBlock(block)).toEqual([]);
  });

  it('dedupes fingerprints in the rendered block', () => {
    expect(parseFingerprintBlock(renderFingerprintBlock([FP_A, FP_A, FP_B]))).toEqual([FP_A, FP_B]);
  });

  it('returns null when no block is present (pre-0.3.0 comment)', () => {
    expect(parseFingerprintBlock('<!-- playwright-ai-triage -->\nold summary')).toBeNull();
  });

  it('returns null for an unknown block version', () => {
    expect(parseFingerprintBlock(`<!-- playwright-ai-triage:fps:v2 ${FP_A} -->`)).toBeNull();
  });

  it('does not parse future versions sharing the v1 prefix (v10, v1.1) as v1', () => {
    expect(parseFingerprintBlock(`<!-- playwright-ai-triage:fps:v10 ${FP_A} -->`)).toBeNull();
    expect(parseFingerprintBlock(`<!-- playwright-ai-triage:fps:v1.1 ${FP_A} -->`)).toBeNull();
  });

  it('drops malformed tokens instead of failing the whole block', () => {
    const body = `<!-- playwright-ai-triage:fps:v1 ${FP_A} not-a-fp ${FP_B}TOOLONG ${FP_B} -->`;
    expect(parseFingerprintBlock(body)).toEqual([FP_A, FP_B]);
  });

  it('is invisible-comment shaped (starts <!--, ends -->, single line)', () => {
    const block = renderFingerprintBlock([FP_A]);
    expect(block).toMatch(/^<!-- playwright-ai-triage:fps:v1 [0-9a-f ]+-->$/);
    expect(block).not.toContain('\n');
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
