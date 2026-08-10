import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ClassifierClient } from '../src/classify.js';
import { resolveConfig } from '../src/config.js';
import {
  confusionMatrix,
  overallAccuracy,
  perClassMetrics,
  type AccuracySummary,
  type ConfusionMatrix,
  type EvalPair,
  type PerClassMetric,
} from '../src/metrics.js';
import { classifyWithSelfConsistency } from '../src/reliability.js';
import { FAILURE_CLASSES } from '../src/types.js';
import { readGoldenCases } from './schema.js';

export interface RunGoldenEvalDeps {
  env?: NodeJS.ProcessEnv;
  client?: ClassifierClient;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  casesDir?: string;
}

interface GoldenEvalReport {
  casesDir: string;
  cases: number;
  draws: number;
  model: string;
  accuracy: AccuracySummary;
  perClass: PerClassMetric[];
  confusion: ConfusionMatrix;
  unanimous: number;
  tied: number;
  unclassifiable: number;
  costUsd: number;
  coverage: Record<string, number>;
  examplesSkipped: number;
  syntheticGraded: number;
  realGraded: number;
}

const EXAMPLE_ID_PREFIX = 'EXAMPLE-';

// Same cap/rationale as src/cli/eval.ts and eval/run.ts's EVAL_DRAWS.
const DRAWS_MAX = 25;

function parseDraws(argv: string[], errorLog: (msg: string) => void): number {
  const flag = argv.find((a) => a.startsWith('--draws='));
  if (!flag) return 3;
  const raw = flag.slice('--draws='.length);
  const parsed = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    errorLog(`--draws=${raw} is not a positive integer — using 3.`);
    return 3;
  }
  let draws = parsed;
  if (draws > DRAWS_MAX) {
    errorLog(`--draws=${raw} exceeds the ${DRAWS_MAX} cap — using ${DRAWS_MAX}.`);
    draws = DRAWS_MAX;
  }
  if (draws > 1 && draws % 2 === 0) {
    errorLog(`--draws=${draws} is even — ties are possible and are reported ungraded.`);
  }
  return draws;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatGoldenReport(report: GoldenEvalReport, asJson: boolean): string {
  if (asJson) return JSON.stringify(report);

  const lines: string[] = [];
  lines.push('Golden-set judge accuracy report');
  lines.push(
    `cases: ${report.casesDir} (${report.cases} cases) · draws per case: ${report.draws} · model: ${report.model}`,
  );
  lines.push('');
  lines.push('Coverage by boundary type:');
  for (const [type, count] of Object.entries(report.coverage).sort()) {
    lines.push(`  ${type}: ${count}`);
  }
  const graded = report.cases - report.examplesSkipped;
  lines.push('');
  if (graded === 0) {
    lines.push('Overall accuracy: no gradeable cases (every case is an excluded EXAMPLE-)');
  } else if (report.accuracy.value === null) {
    lines.push('Overall accuracy: no gradeable cases (every case tied or unclassifiable)');
  } else {
    lines.push(
      `Overall accuracy: ${pct(report.accuracy.value)} ` +
        `(95% CI ${pct(report.accuracy.ci!.low)}–${pct(report.accuracy.ci!.high)}, n=${report.accuracy.n})`,
    );
  }
  lines.push(
    `Self-consistency: ${report.unanimous}/${graded} graded cases unanimous across ${report.draws} draws` +
      ` · ${report.tied} tied (excluded from grading) · ${report.unclassifiable} unclassifiable`,
  );
  lines.push('');
  if (report.examplesSkipped > 0) {
    lines.push(
      `${report.examplesSkipped} example case(s) excluded from grading (id starts with EXAMPLE-)`,
    );
    lines.push('');
  }
  if (graded > 0) {
    lines.push(
      `${report.syntheticGraded}/${graded} graded cases are synthetic (${report.realGraded} real)` +
        ' — see evals/README.md\'s "How cases are collected and labeled" for what that means.',
    );
    lines.push('');
  }
  lines.push('Per-class:');
  for (const m of report.perClass) {
    const precision =
      m.precision === null
        ? 'n/a'
        : `${m.precision.toFixed(2)} (${m.precisionCI!.low.toFixed(2)}-${m.precisionCI!.high.toFixed(2)})`;
    const recall =
      m.recall === null
        ? 'n/a'
        : `${m.recall.toFixed(2)} (${m.recallCI!.low.toFixed(2)}-${m.recallCI!.high.toFixed(2)})`;
    const f1 = m.f1 === null ? 'n/a' : m.f1.toFixed(2);
    lines.push(
      `${m.class.padEnd(15)} precision ${precision.padEnd(18)} recall ${recall.padEnd(18)} f1 ${f1.padEnd(6)} support ${m.support}` +
        (m.lowSupport ? '  (low support)' : ''),
    );
  }
  lines.push('');
  lines.push('Confusion matrix (rows = actual, columns = predicted)');
  lines.push(['', ...FAILURE_CLASSES].join('\t'));
  for (const actual of FAILURE_CLASSES) {
    lines.push(
      [actual, ...FAILURE_CLASSES.map((p) => String(report.confusion[actual][p]))].join('\t'),
    );
  }
  lines.push('');
  lines.push(`cost of this run: $${report.costUsd.toFixed(4)}`);
  return lines.join('\n');
}

const DEFAULT_CASES_DIR = fileURLToPath(new URL('./golden/cases', import.meta.url));

export async function runGoldenEval(argv: string[], deps: RunGoldenEvalDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;
  const casesDir = deps.casesDir ?? DEFAULT_CASES_DIR;

  const config = resolveConfig({}, env, () => {});
  if (!config.apiKey) {
    errorLog('ANTHROPIC_API_KEY is not set — eval:golden needs to classify every case live.');
    return 2;
  }

  let cases;
  try {
    cases = readGoldenCases(casesDir);
  } catch (error) {
    errorLog(
      `failed to read golden cases from ${casesDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  if (cases.length === 0) {
    errorLog(`${casesDir} has no golden cases.`);
    return 2;
  }

  const draws = parseDraws(argv, errorLog);
  const asJson = argv.includes('--json');

  const pairs: EvalPair[] = [];
  let unanimous = 0;
  let tied = 0;
  let unclassifiable = 0;
  let costUsd = 0;
  let examplesSkipped = 0;
  let syntheticGraded = 0;
  let realGraded = 0;
  const coverage: Record<string, number> = {};

  for (const goldenCase of cases) {
    if (goldenCase.id.startsWith(EXAMPLE_ID_PREFIX)) {
      examplesSkipped += 1;
      continue;
    }
    coverage[goldenCase.boundaryType] = (coverage[goldenCase.boundaryType] ?? 0) + 1;
    if (goldenCase.synthetic) {
      syntheticGraded += 1;
    } else {
      realGraded += 1;
    }
    const result = await classifyWithSelfConsistency(goldenCase.payload, config, draws, {
      client: deps.client,
    });
    if (!result) {
      unclassifiable += 1;
      continue;
    }
    costUsd += result.costUsd;
    if (result.summary.tied) {
      tied += 1;
      continue;
    }
    if (!result.summary.unstable) unanimous += 1;
    pairs.push({ predicted: result.summary.classification.class, actual: goldenCase.humanClass });
  }

  const report: GoldenEvalReport = {
    casesDir,
    cases: cases.length,
    draws,
    model: config.model,
    accuracy: overallAccuracy(pairs),
    perClass: perClassMetrics(pairs),
    confusion: confusionMatrix(pairs),
    unanimous,
    tied,
    unclassifiable,
    costUsd,
    coverage,
    examplesSkipped,
    syntheticGraded,
    realGraded,
  };

  log(formatGoldenReport(report, asJson));
  return 0;
}

// realpathSync-resolved: import.meta.url resolves through a symlink to the
// REAL path, but process.argv[1] does not — a plain-path comparison here
// silently never fires under a symlinked invocation (see src/cli.ts).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  runGoldenEval(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
