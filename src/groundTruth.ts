import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import { FAILURE_CLASSES, type FailureClass } from './types.js';

const failureRetrySchema = z.object({
  attempt: z.number(),
  status: z.enum(['failed', 'passed', 'timedOut', 'skipped', 'interrupted']),
  errorHead: z.string().optional(),
});

const failedRequestSchema = z.object({
  status: z.number(),
  method: z.string(),
  url: z.string(),
});

/** Mirrors src/types.ts's FailurePayload exactly — this is the ground-truth
 * dataset's persisted shape, so drift from the live type must be caught by
 * tests, not discovered at eval time against a stale file. */
export const failurePayloadSchema = z.object({
  testId: z.string(),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  errorMessage: z.string(),
  stack: z.string(),
  failingStep: z.string().optional(),
  retries: z.array(failureRetrySchema),
  retryThenPassed: z.boolean(),
  heuristicPrior: z.enum(['FLAKY', 'ENV_ISSUE']).optional(),
  domSnippet: z.string().optional(),
  failedRequests: z.array(failedRequestSchema).optional(),
  diffSummary: z.string().optional(),
  duration: z.number(),
  timeoutMs: z.number().optional(),
});

export const failureClassSchema = z.enum(FAILURE_CLASSES as [FailureClass, ...FailureClass[]]);

export const groundTruthRecordSchema = z.object({
  /** dedup key — re-labeling the same fingerprint overwrites, never duplicates */
  fingerprint: z.string(),
  payload: failurePayloadSchema,
  /** the ground truth, set by a human during `label` */
  humanClass: failureClassSchema,
  /** what the judge said at label time — audit trail only, not used by `eval` */
  predictedClass: failureClassSchema,
  predictedConfidence: z.number(),
  labeledAt: z.string(),
  notes: z.string().optional(),
});

export type GroundTruthRecord = z.infer<typeof groundTruthRecordSchema>;

/** Missing file returns []  — a brand-new dataset. Malformed content throws
 * loud with the offending line number: a silently-skipped bad row would
 * corrupt the metrics without anyone noticing. */
export function readDataset(path: string): GroundTruthRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}: line ${index + 1} is not valid JSON: ${message}`, { cause: error });
    }
    const result = groundTruthRecordSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`${path}: line ${index + 1} failed schema validation: ${issues}`);
    }
    return result.data;
  });
}

export function writeDataset(path: string, records: GroundTruthRecord[]): void {
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, body.length > 0 ? `${body}\n` : '');
}

/** Rewrites the whole file — simple and correct for the dataset sizes a human
 * labeling session produces (hundreds to low thousands of rows), not a
 * high-throughput append log. */
export function appendOrUpdateRecord(path: string, record: GroundTruthRecord): void {
  const existing = readDataset(path);
  const index = existing.findIndex((r) => r.fingerprint === record.fingerprint);
  if (index >= 0) existing[index] = record;
  else existing.push(record);
  writeDataset(path, existing);
}
