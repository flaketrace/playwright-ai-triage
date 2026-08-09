import type { ClassifierClient } from '../classify.js';
import { resolveConfig } from '../config.js';
import { readDataset } from '../groundTruth.js';
import {
  confusionMatrix,
  overallAccuracy,
  perClassMetrics,
  type AccuracySummary,
  type ConfusionMatrix,
  type EvalPair,
  type PerClassMetric,
} from '../metrics.js';
import { classifyWithSelfConsistency } from '../reliability.js';
import { FAILURE_CLASSES } from '../types.js';

export interface RunEvalDeps {
  env?: NodeJS.ProcessEnv;
  client?: ClassifierClient;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
}

interface EvalReport {
  datasetPath: string;
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
}

// Matches eval/run.ts's EVAL_DRAWS cap: looser parsing would silently run
// far more PAID calls than requested.
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

export function formatReport(report: EvalReport, asJson: boolean): string {
  if (asJson) return JSON.stringify(report);

  const lines: string[] = [];
  lines.push('Judge reliability report');
  lines.push(
    `dataset: ${report.datasetPath} (${report.cases} cases) · draws per case: ${report.draws} · model: ${report.model}`,
  );
  lines.push('');
  if (report.accuracy.value === null) {
    lines.push('Overall accuracy: no gradeable cases (every case tied or unclassifiable)');
  } else {
    lines.push(
      `Overall accuracy: ${pct(report.accuracy.value)} ` +
        `(95% CI ${pct(report.accuracy.ci!.low)}–${pct(report.accuracy.ci!.high)}, n=${report.accuracy.n})`,
    );
  }
  lines.push(
    `Self-consistency: ${report.unanimous}/${report.cases} cases unanimous across ${report.draws} draws` +
      ` · ${report.tied} tied (excluded from grading) · ${report.unclassifiable} unclassifiable`,
  );
  lines.push('');
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

export async function runEval(argv: string[], deps: RunEvalDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;

  const datasetPath = env.AI_TRIAGE_EVAL_DATASET;
  if (!datasetPath) {
    errorLog('AI_TRIAGE_EVAL_DATASET is not set — point it at your local ground-truth JSONL file.');
    return 2;
  }

  const config = resolveConfig({}, env, () => {});
  if (!config.apiKey) {
    errorLog('ANTHROPIC_API_KEY is not set — eval needs to re-classify every case live.');
    return 2;
  }

  let records;
  try {
    records = readDataset(datasetPath);
  } catch (error) {
    errorLog(
      `failed to read ${datasetPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  if (records.length === 0) {
    errorLog(`${datasetPath} is empty — nothing to evaluate. Label some cases first.`);
    return 2;
  }

  const draws = parseDraws(argv, errorLog);
  const asJson = argv.includes('--json');

  const pairs: EvalPair[] = [];
  let unanimous = 0;
  let tied = 0;
  let unclassifiable = 0;
  let costUsd = 0;

  for (const record of records) {
    const result = await classifyWithSelfConsistency(record.payload, config, draws, {
      client: deps.client,
    });
    if (!result) {
      // Every draw errored — no real judge verdict was ever produced, so
      // there is nothing to grade. This must not contribute a fabricated
      // UNCLASSIFIED pair to the confusion matrix.
      unclassifiable += 1;
      continue;
    }
    costUsd += result.costUsd;
    if (result.summary.tied) {
      tied += 1;
      continue;
    }
    if (!result.summary.unstable) unanimous += 1;
    pairs.push({ predicted: result.summary.classification.class, actual: record.humanClass });
  }

  const report: EvalReport = {
    datasetPath,
    cases: records.length,
    draws,
    model: config.model,
    accuracy: overallAccuracy(pairs),
    perClass: perClassMetrics(pairs),
    confusion: confusionMatrix(pairs),
    unanimous,
    tied,
    unclassifiable,
    costUsd,
  };

  log(formatReport(report, asJson));
  return 0;
}
