import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PROMPT_VERSION, SYSTEM_PROMPT } from '../src/prompt.js';

describe('SYSTEM_PROMPT self-consistency', () => {
  it('PROMPT_VERSION matches the vNNN format', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });

  it('the Examples header count matches the number of [real, sanitized] entries', () => {
    const headerMatch = SYSTEM_PROMPT.match(/## Examples \((\d+) real, sanitized/);
    expect(headerMatch).not.toBeNull();
    const declaredCount = Number(headerMatch![1]);
    const actualCount = (SYSTEM_PROMPT.match(/\[real, sanitized\]/g) ?? []).length;
    expect(actualCount).toBe(declaredCount);
  });
});

describe('prompt version history discloses no evaluation results', () => {
  // The version history explains WHY each rule exists — that reasoning is the file's
  // value and belongs in public source. Measured eval results do not: they sit behind
  // an internal quality gate. Three consecutive prompt versions leaked a figure here
  // before anyone noticed, so the guard is mechanical rather than social.
  //
  // Scope: EVERYTHING above the PROMPT_VERSION declaration, not just the first comment
  // block. Documenting a new version in its own block below the existing one is a
  // plausible authoring path, and a first-block-only guard would never see it.
  //
  // SYSTEM_PROMPT is deliberately out of scope — it sits below PROMPT_VERSION and
  // legitimately contains figures (attempt counts inside sanitized examples, confidence
  // values, HTTP status-code lists) that are prompt content, not eval results.
  //
  // This guard errs toward false positives: blocking a legitimate edit costs a minute,
  // leaking a gated number costs more. If it misfires, reword rather than delete it.
  const source = readFileSync(fileURLToPath(new URL('../src/prompt.ts', import.meta.url)), 'utf8');
  const versionDeclIndex = source.indexOf('export const PROMPT_VERSION');
  const history = versionDeclIndex === -1 ? '' : source.slice(0, versionDeclIndex);

  const DISCLOSURE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
    // Anchored so neither side abuts another digit or slash, and at least one side
    // must be 1-2 digits. That excludes dates and HTTP status pairs (both sides are
    // always 3-digit) while still catching every score-shaped ratio a fixture batch
    // can produce.
    ['a per-class ratio (N/M)', /(?<![\d/])(?:\d{1,2}\/\d{1,3}|\d{1,3}\/\d{1,2})(?![\d/])/],
    ['a written ratio (N of M)', /\b\d+\s+of\s+\d+\s+(?:fixtures?|cases?|samples?|runs?)\b/i],
    ['a percentage', /\b\d+(?:\.\d+)?\s*(?:%|percent)\b/i],
    ['an eval-set size', /\b\d+[-\s]fixtures?\b/i],
    ['a named baseline measurement', /\bbaseline\s+(?:of\s+)?\d/i],
    [
      'an alarm or error rate',
      /\b(?:~|about|roughly|approx\.?)?\s*\d+\s+(?:false|incorrect|missed)\b/i,
    ],
    ['a stated accuracy', /\baccuracy\s+(?:of\s+|rose\s+to\s+|was\s+)?\d/i],
  ];

  it('scans the whole region above PROMPT_VERSION, including the current version', () => {
    // Ties the sentinel to the live version string, so the newest changelog entry is
    // provably inside the scanned region. A wrong-region slice cannot pass this.
    expect(versionDeclIndex).toBeGreaterThan(-1);
    expect(history).toContain(PROMPT_VERSION);
    expect(history.length).toBeGreaterThan(200);
  });

  for (const [label, pattern] of DISCLOSURE_PATTERNS) {
    it(`contains no ${label}`, () => {
      // Re-assert scope inside each case: module-scope state is shared, so a broken
      // slice would otherwise let these five report green while the sentinel fails.
      expect(history).toContain(PROMPT_VERSION);
      const hit = history.match(pattern);
      expect(
        hit,
        hit
          ? `Gated eval result found in the prompt version history: "${hit[0]}". ` +
              `Keep the engineering rationale, drop the measurement.`
          : undefined,
      ).toBeNull();
    });
  }
});
