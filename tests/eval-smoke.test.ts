import { describe, expect, it } from 'vitest';

import { SMOKE_FIXTURES } from '../eval/fixtures.js';
import { grade } from '../eval/grade.js';
import { infraReason } from '../eval/infra.js';
import { classifyFailures } from '../src/classify.js';
import { heuristicFor } from '../src/heuristics.js';
import type { Classification } from '../src/types.js';

const classification = (overrides: Partial<Classification> = {}): Classification => ({
  class: 'REAL_BUG',
  confidence: 0.9,
  why: 'test',
  ...overrides,
});

describe('smoke-eval fixtures', () => {
  it('provides at least 5 fixtures with unique names', () => {
    expect(SMOKE_FIXTURES.length).toBeGreaterThanOrEqual(5);
    const names = SMOKE_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every fixture actually reaches the model — none is heuristic-decidable locally', () => {
    for (const fixture of SMOKE_FIXTURES) {
      expect(heuristicFor(fixture.payload).verdict, fixture.name).toBeUndefined();
    }
  });

  it('every fixture has a non-empty acceptable set and a testId matching its name', () => {
    for (const fixture of SMOKE_FIXTURES) {
      expect(fixture.acceptable.length, fixture.name).toBeGreaterThan(0);
      expect(fixture.payload.testId, fixture.name).toBe(fixture.name);
    }
  });

  it('covers the judgment classes: REAL_BUG, SELECTOR_DRIFT, ENV_ISSUE all appear as primary ground truth', () => {
    const primaries = new Set(SMOKE_FIXTURES.flatMap((f) => f.acceptable));
    for (const cls of ['REAL_BUG', 'SELECTOR_DRIFT', 'ENV_ISSUE'] as const) {
      expect(primaries.has(cls), cls).toBe(true);
    }
  });

  it('keeps capped classes disjoint from the acceptable set (an overlapping cap is dead code)', () => {
    for (const fixture of SMOKE_FIXTURES) {
      for (const cap of fixture.capped ?? []) {
        expect(fixture.acceptable, `${fixture.name}: ${cap.class}`).not.toContain(cap.class);
      }
    }
  });
});

describe('infraReason', () => {
  const ok: Classification = {
    class: 'ENV_ISSUE',
    confidence: 0.7,
    why: 'the payload shows a 503',
  };

  it('flags infra notes (API error, no key, refusal)', () => {
    expect(infraReason(['classifier API error after retries: boom'], ok)).toBeTruthy();
    expect(
      infraReason(['ANTHROPIC_API_KEY is not set — 1 failure(s) left unclassified'], ok),
    ).toBeTruthy();
  });

  it('flags a sentinel UNCLASSIFIED that never came from the model (missing testId in output)', () => {
    const sentinel: Classification = {
      class: 'UNCLASSIFIED',
      confidence: 0,
      why: 'no schema-valid classification returned',
    };
    expect(infraReason([], sentinel)).toBeTruthy();
  });

  it('flags a missing classification', () => {
    expect(infraReason([], undefined)).toBeTruthy();
  });

  it('does NOT flag a legitimate model-chosen UNCLASSIFIED', () => {
    const genuine: Classification = {
      class: 'UNCLASSIFIED',
      confidence: 0.2,
      why: 'the evidence is genuinely insufficient to choose a class',
    };
    expect(infraReason([], genuine)).toBeUndefined();
    expect(infraReason([], ok)).toBeUndefined();
  });

  // Live coupling pin: drives the REAL classifyFailures with a mocked client so a
  // future rewording of classify.ts's sentinel strings breaks this test instead of
  // silently defeating infra detection.
  it('flags the real classifyFailures output when the response omits the testId', async () => {
    const client = {
      messages: {
        parse: async () => ({
          parsed_output: { classifications: [] },
          usage: { input_tokens: 10, output_tokens: 10 },
          stop_reason: 'end_turn',
        }),
      },
    };
    const config = {
      model: 'claude-haiku-4-5',
      outputs: ['stdout' as const],
      includeDom: false,
      maxFailures: 25,
      dryRun: false,
      failSilently: true,
      apiKey: 'test-key',
      githubToken: undefined,
      slackWebhookUrl: undefined,
      diffSummary: undefined,
    };
    const payload = SMOKE_FIXTURES[0]?.payload;
    if (!payload) throw new Error('smoke fixtures are empty');
    const result = await classifyFailures([payload], config, { client });
    expect(infraReason(result.notes, result.classified[0]?.classification)).toBeTruthy();
  });
});

describe('grade', () => {
  const fixture = (name: string, overrides: Partial<(typeof SMOKE_FIXTURES)[number]> = {}) => ({
    name,
    payload: { testId: name } as (typeof SMOKE_FIXTURES)[number]['payload'],
    acceptable: ['REAL_BUG'] as Classification['class'][],
    ...overrides,
  });

  it('passes a result whose class is in the acceptable set', () => {
    const report = grade([fixture('a')], new Map([['a', classification({ class: 'REAL_BUG' })]]));
    expect(report.rows[0]?.pass).toBe(true);
    expect(report.passed).toBe(1);
    expect(report.allPass).toBe(true);
  });

  it('fails a result whose class is outside the acceptable set', () => {
    const report = grade([fixture('a')], new Map([['a', classification({ class: 'FLAKY' })]]));
    expect(report.rows[0]?.pass).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.allPass).toBe(false);
  });

  it('passes a capped class only at or below its confidence cap', () => {
    const hedgy = fixture('a', {
      acceptable: ['ENV_ISSUE'] as Classification['class'][],
      capped: [{ class: 'SELECTOR_DRIFT' as const, max: 0.5 }],
    });
    const hedged = grade(
      [hedgy],
      new Map([['a', classification({ class: 'SELECTOR_DRIFT', confidence: 0.45 })]]),
    );
    expect(hedged.rows[0]?.pass).toBe(true);
    const overconfident = grade(
      [hedgy],
      new Map([['a', classification({ class: 'SELECTOR_DRIFT', confidence: 0.8 })]]),
    );
    expect(overconfident.rows[0]?.pass).toBe(false);
    // the cap is inclusive — exactly at the cap passes
    const boundary = grade(
      [hedgy],
      new Map([['a', classification({ class: 'SELECTOR_DRIFT', confidence: 0.5 })]]),
    );
    expect(boundary.rows[0]?.pass).toBe(true);
  });

  it('fails a fixture with no returned classification', () => {
    const report = grade([fixture('a')], new Map());
    expect(report.rows[0]?.pass).toBe(false);
    expect(report.rows[0]?.actual).toBeUndefined();
    expect(report.allPass).toBe(false);
  });

  it('counts across multiple fixtures', () => {
    const report = grade(
      [fixture('a'), fixture('b')],
      new Map([
        ['a', classification({ class: 'REAL_BUG' })],
        ['b', classification({ class: 'ENV_ISSUE' })],
      ]),
    );
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.allPass).toBe(false);
  });
});
