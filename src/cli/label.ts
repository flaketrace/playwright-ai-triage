import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { z } from 'zod';

import {
  appendOrUpdateRecord,
  failureClassSchema,
  failurePayloadSchema,
  readDataset,
} from '../groundTruth.js';
import { FAILURE_CLASSES, type FailureClass } from '../types.js';

export interface RunLabelDeps {
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  readFile?: (path: string) => string;
  ask?: (question: string) => Promise<string>;
}

const sinkFailureSchema = z.object({
  fingerprint: z.string(),
  payload: failurePayloadSchema,
  classification: z.object({
    class: failureClassSchema,
    confidence: z.number(),
    why: z.string(),
  }),
});

const sinkEnvelopeSchema = z.object({
  schema: z.literal('ai-triage-sink/v1'),
  failures: z.array(sinkFailureSchema),
});

function parseArgs(argv: string[]): { run: string | undefined } {
  const index = argv.indexOf('--run');
  return { run: index >= 0 ? argv[index + 1] : undefined };
}

async function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function runLabel(argv: string[], deps: RunLabelDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const ask = deps.ask ?? defaultAsk;

  const { run } = parseArgs(argv);
  if (!run) {
    errorLog('--run <path-to-sink-envelope.json> is required.');
    return 2;
  }

  const datasetPath = env.AI_TRIAGE_EVAL_DATASET;
  if (!datasetPath) {
    errorLog('AI_TRIAGE_EVAL_DATASET is not set — point it at your local ground-truth JSONL file.');
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFile(run));
  } catch (error) {
    errorLog(`failed to read ${run}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const parsedEnvelope = sinkEnvelopeSchema.safeParse(raw);
  if (!parsedEnvelope.success) {
    errorLog(`${run} is not a valid ai-triage-sink/v1 envelope.`);
    return 2;
  }

  const existing = readDataset(datasetPath);
  const seen = new Set(existing.map((r) => r.fingerprint));
  const pending = parsedEnvelope.data.failures.filter((f) => !seen.has(f.fingerprint));

  if (pending.length === 0) {
    log('nothing to label — every fingerprint in this run is already in the dataset.');
    return 0;
  }

  let labeled = 0;
  for (const failure of pending) {
    log(
      `\n${failure.payload.title} (${failure.payload.file}:${failure.payload.line})\n` +
        `  error: ${failure.payload.errorMessage.split('\n')[0]}\n` +
        `  predicted: ${failure.classification.class} @ ${failure.classification.confidence.toFixed(2)} — ${failure.classification.why}`,
    );

    let humanClass: FailureClass | undefined;
    let answered = false;
    while (!answered) {
      const answer = (
        await ask(`"${failure.payload.title}" correct? [y]es / [n]o / [s]kip / [q]uit: `)
      )
        .trim()
        .toLowerCase();
      if (answer === 'y') {
        humanClass = failure.classification.class;
        answered = true;
      } else if (answer === 'n') {
        let cls: string | undefined;
        while (!cls || !FAILURE_CLASSES.includes(cls as FailureClass)) {
          cls = (await ask(`correct class? (${FAILURE_CLASSES.join('/')}): `)).trim();
        }
        humanClass = cls as FailureClass;
        answered = true;
      } else if (answer === 's') {
        answered = true; // humanClass stays undefined — skip, no record written
      } else if (answer === 'q') {
        log(`\nstopping — ${labeled} case(s) labeled this session.`);
        return 0;
      } else {
        log('please answer y, n, s, or q.');
      }
    }

    if (humanClass) {
      appendOrUpdateRecord(datasetPath, {
        fingerprint: failure.fingerprint,
        payload: failure.payload,
        humanClass,
        predictedClass: failure.classification.class,
        predictedConfidence: failure.classification.confidence,
        labeledAt: new Date().toISOString(),
      });
      labeled += 1;
    }
  }

  log(`\ndone — ${labeled} case(s) labeled this session.`);
  return 0;
}
