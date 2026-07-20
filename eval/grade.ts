import type { Classification, FailureClass } from '../src/types.js';

import type { SmokeFixture } from './fixtures.js';

export interface GradeRow {
  name: string;
  acceptable: FailureClass[];
  actual: FailureClass | undefined;
  confidence: number | undefined;
  pass: boolean;
  note: string;
}

export interface GradeReport {
  rows: GradeRow[];
  passed: number;
  failed: number;
  /**
   * ⚠️ `passed === rows.length` over ALL rows, including any the caller chose
   * not to grade (those arrive here with no result and count as failures). A
   * caller that excludes rows — e.g. indeterminate ones — must compare
   * `passed` against its own gradeable count, NOT read this field: doing the
   * latter once made an entire exit branch unreachable.
   */
  allPass: boolean;
}

export function grade(fixtures: SmokeFixture[], results: Map<string, Classification>): GradeReport {
  const rows: GradeRow[] = fixtures.map((fixture) => {
    const result = results.get(fixture.name);
    if (!result) {
      return {
        name: fixture.name,
        acceptable: fixture.acceptable,
        actual: undefined,
        confidence: undefined,
        pass: false,
        note: 'no classification returned',
      };
    }
    if (fixture.acceptable.includes(result.class)) {
      return {
        name: fixture.name,
        acceptable: fixture.acceptable,
        actual: result.class,
        confidence: result.confidence,
        pass: true,
        note: '',
      };
    }
    const cap = fixture.capped?.find((c) => c.class === result.class);
    if (cap && result.confidence <= cap.max) {
      return {
        name: fixture.name,
        acceptable: fixture.acceptable,
        actual: result.class,
        confidence: result.confidence,
        pass: true,
        note: `hedged within the ≤${cap.max} cap`,
      };
    }
    return {
      name: fixture.name,
      acceptable: fixture.acceptable,
      actual: result.class,
      confidence: result.confidence,
      pass: false,
      note: cap ? `over the ≤${cap.max} confidence cap` : 'class not acceptable',
    };
  });

  const passed = rows.filter((r) => r.pass).length;
  return { rows, passed, failed: rows.length - passed, allPass: passed === rows.length };
}
