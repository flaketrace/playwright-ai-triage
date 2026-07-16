/**
 * Public smoke-eval for the classifier prompt — local, bring-your-own-key.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run eval:smoke
 *
 * One API call per fixture (isolation: one bad batch can't corrupt the table).
 * Infra errors ABORT the run without grading — a half-graded table is worse
 * than no table. Exit codes: 0 all class-accurate · 1 eval failure ·
 * 2 missing key · 3 infra abort.
 *
 * This is a SMOKE eval: class-only assertions on fully synthetic fixtures. It
 * catches gross prompt regressions in the open; it does not replace the full
 * real-world-derived eval run by the maintainer before prompt changes merge.
 */
import { classifyFailures } from '../src/classify.js';
import { resolveConfig } from '../src/config.js';
import { PROMPT_VERSION } from '../src/prompt.js';
import type { Classification } from '../src/types.js';

import { SMOKE_FIXTURES } from './fixtures.js';
import { grade } from './grade.js';
import { infraReason } from './infra.js';

const config = resolveConfig({ outputs: ['stdout'] }, process.env, () => {});

if (!config.apiKey) {
  console.error(
    'ANTHROPIC_API_KEY is not set. The smoke eval makes real API calls ' +
      `(${SMOKE_FIXTURES.length} Haiku calls, a fraction of a cent).`,
  );
  process.exit(2);
}

console.log(
  `smoke-eval · prompt ${PROMPT_VERSION} · model ${config.model} · ` +
    `${SMOKE_FIXTURES.length} fixtures, one call each\n`,
);

const results = new Map<string, Classification>();
let costUsd = 0;

try {
  for (const fixture of SMOKE_FIXTURES) {
    const result = await classifyFailures([fixture.payload], config);
    const classification = result.classified[0]?.classification;
    const infra = infraReason(result.notes, classification);
    if (infra || !classification) {
      console.error(`ABORT — infra problem, results not graded: ${infra}`);
      process.exit(3);
    }
    results.set(fixture.name, classification);
    costUsd += result.costUsd ?? 0;
  }
} catch (error) {
  console.error(
    `ABORT — unexpected error, results not graded: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(3);
}

const report = grade(SMOKE_FIXTURES, results);
for (const row of report.rows) {
  const confidence = row.confidence === undefined ? '' : ` @ ${row.confidence.toFixed(2)}`;
  const note = row.note ? `  (${row.note})` : '';
  console.log(
    `${row.pass ? 'PASS' : 'FAIL'}  ${row.name}  →  ${row.actual ?? '(none)'}${confidence}` +
      `  accept: ${row.acceptable.join(' | ')}${note}`,
  );
}
console.log(
  `\n${report.passed}/${report.rows.length} class-accurate · cost of this run: $${costUsd.toFixed(4)}`,
);
process.exit(report.allPass ? 0 : 1);
