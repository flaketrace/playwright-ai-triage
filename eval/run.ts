/**
 * Public smoke-eval for the classifier prompt — local, bring-your-own-key.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run eval:smoke
 *
 * One API call per fixture per draw (isolation: one bad batch can't corrupt the
 * table). Infra errors ABORT the run without grading — a half-graded table is
 * worse than no table. Exit codes: 0 all class-accurate · 1 eval failure ·
 * 2 missing key · 3 infra abort · 4 no graded fixture missed but one or more
 * were INDETERMINATE (tied draws — measurement absent, not a regression; also
 * covers the all-tied case, where nothing was graded). Only reachable at
 * EVAL_DRAWS>1, so 0/1 semantics are unchanged by default.
 *
 * EVAL_DRAWS=N (default 1, capped at 25) classifies each fixture N times and
 * grades the MODAL class, reporting per-fixture agreement. A fixture whose top
 * class is not outright (1-1, 2-2-1) is INDETERMINATE and reported ungraded —
 * an even N is warned about, since it invites those ties. Classification is a draw
 * from a distribution — sampling is not configurable on current models — so a
 * single-draw table reports a point estimate whose variance it cannot see. At
 * N>1 an "unstable" fixture (majority correct, but not unanimous) is visible
 * even while the accuracy figure looks perfect. Cost scales linearly with N.
 *
 * This is a SMOKE eval: class-only assertions on fully synthetic fixtures. It
 * catches gross prompt regressions in the open; it does not replace the full
 * real-world-derived eval run by the maintainer before prompt changes merge.
 */
import { classifyFailures } from '../src/classify.js';
import { resolveConfig } from '../src/config.js';
import { PROMPT_VERSION } from '../src/prompt.js';
import type { Classification } from '../src/types.js';

import { summarizeDraws, type DrawSummary } from './draws.js';
import { evalExitCode } from './exit.js';
import { SMOKE_FIXTURES } from './fixtures.js';
import { grade } from './grade.js';
import { infraReason } from './infra.js';

const config = resolveConfig({ outputs: ['stdout'] }, process.env, () => {});

// Strict decimal parse: Number() would accept 1e3 / 0x10 / ' 3' and silently
// run far more PAID calls than requested. Validate the value we will actually use.
const DRAWS_MAX = 25;
const drawsEnv = process.env.EVAL_DRAWS;
let DRAWS = 1;
if (drawsEnv !== undefined && drawsEnv !== '') {
  const parsed = /^[0-9]+$/.test(drawsEnv.trim()) ? Number(drawsEnv.trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`EVAL_DRAWS=${drawsEnv} is not a positive integer — using 1.`);
  } else if (parsed > DRAWS_MAX) {
    console.error(`EVAL_DRAWS=${drawsEnv} exceeds the ${DRAWS_MAX} cap — using ${DRAWS_MAX}.`);
    DRAWS = DRAWS_MAX;
  } else {
    DRAWS = parsed;
  }
}
if (DRAWS > 1 && DRAWS % 2 === 0) {
  console.error(`EVAL_DRAWS=${DRAWS} is even — ties are possible and are reported ungraded.`);
}

if (!config.apiKey) {
  console.error(
    'ANTHROPIC_API_KEY is not set. The smoke eval makes real API calls ' +
      `(${SMOKE_FIXTURES.length * DRAWS} Haiku calls, a fraction of a cent).`,
  );
  process.exit(2);
}

console.log(
  `smoke-eval · prompt ${PROMPT_VERSION} · model ${config.model} · ` +
    (DRAWS === 1
      ? `${SMOKE_FIXTURES.length} fixtures, one call each\n`
      : `${SMOKE_FIXTURES.length} fixtures × ${DRAWS} draws\n`),
);

const results = new Map<string, Classification>();
/** the collapsed verdict + its agreement, per fixture (§14.2b) */
const summaries = new Map<string, DrawSummary>();
let costUsd = 0;

try {
  for (const fixture of SMOKE_FIXTURES) {
    const perFixture: Classification[] = [];
    for (let draw = 0; draw < DRAWS; draw += 1) {
      const result = await classifyFailures([fixture.payload], config);
      const classification = result.classified[0]?.classification;
      const infra = infraReason(result.notes, classification);
      if (infra || !classification) {
        console.error(`ABORT — infra problem, results not graded: ${infra}`);
        process.exit(3);
      }
      perFixture.push(classification);
      costUsd += result.costUsd ?? 0;
    }
    const summary = summarizeDraws(perFixture);
    if (!summary) {
      console.error(`ABORT — no draws collected for ${fixture.name}.`);
      process.exit(3);
    }
    summaries.set(fixture.name, summary);
    // A tie is not a verdict. grade() has no ungraded state, so a tied fixture
    // is left out of `results` and lands in its missing-entry branch as
    // pass:false; the printer and the exit code below both treat it as
    // indeterminate instead, and the accuracy figure excludes it.
    if (!summary.tied) results.set(fixture.name, summary.classification);
  }
} catch (error) {
  console.error(
    `ABORT — unexpected error, results not graded: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(3);
}

const report = grade(SMOKE_FIXTURES, results);
let unstable = 0;
let tiedCount = 0;
for (const row of report.rows) {
  // agreement comes from the tested collapse function, never re-derived here
  const summary = summaries.get(row.name);
  if (summary?.unstable) unstable += 1;
  if (summary?.tied) tiedCount += 1;
  // A tied row must not display a class in the scannable column: the modal
  // class there is whichever draw happened to return first.
  let shown: string;
  let confidence: string;
  let note: string;
  if (summary?.tied) {
    shown = '(tied)';
    confidence = '';
    note = `  (${summary.agreeing}/${summary.total} split — indeterminate, not graded)`;
  } else {
    shown = row.actual ?? '(none)';
    confidence = row.confidence === undefined ? '' : ` @ ${row.confidence.toFixed(2)}`;
    note = row.note ? `  (${row.note})` : '';
  }
  const agreement =
    summary && DRAWS > 1
      ? `  [${summary.agreeing}/${summary.total}${summary.unstable ? ' UNSTABLE' : ''}]`
      : '';
  const verdict = summary?.tied ? 'TIED' : row.pass ? 'PASS' : 'FAIL';
  console.log(
    `${verdict}  ${row.name}  →  ${shown}${confidence}` +
      `${agreement}  accept: ${row.acceptable.join(' | ')}${note}`,
  );
}
// Accuracy is reported over GRADEABLE fixtures only. A tie is not an
// inaccuracy — it is an absence of measurement — so folding it into this
// figure would misreport the classifier in exactly the direction this
// change exists to prevent.
const gradeable = report.rows.length - tiedCount;
console.log(
  `\n` +
    (gradeable === 0
      ? 'nothing gradeable — every fixture tied'
      : `${report.passed}/${gradeable} class-accurate`) +
    (tiedCount > 0 ? ` · ${tiedCount} indeterminate (not graded)` : '') +
    ` · cost of this run: $${costUsd.toFixed(4)}`,
);
if (DRAWS > 1) {
  console.log(
    // denominator is ALL fixtures, unlike the accuracy line: unanimity is
    // measurable for a tied fixture too (it is by definition not unanimous)
    `${report.rows.length - unstable}/${report.rows.length} unanimous across ${DRAWS} draws` +
      (unstable > 0
        ? ` — ${unstable} fixture(s) flipped class between identical calls; the accuracy figure above is a majority verdict, not a stable one.`
        : ' — every fixture classified identically on every draw.') +
      (tiedCount > 0 ? ` ${tiedCount} tied and were not graded.` : ''),
  );
}
// report.allPass is NOT usable here: it is passed === rows.length over all
// rows, tied ones included, so it is false whenever anything tied — which
// made the indeterminate exit unreachable. Judge over gradeable only.
process.exit(evalExitCode({ passed: report.passed, gradeable, tiedCount }));
