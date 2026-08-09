import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { failureClassSchema, failurePayloadSchema } from '../src/groundTruth.js';

/**
 * The whole point of a hard-boundary dataset: 'other' exists for genuinely
 * novel boundary shapes, but a dataset that leans on it heavily has stopped
 * curating and started dumping — see evals/README.md's coverage table.
 */
export const BOUNDARY_TYPES = [
  'flaky-as-real-bug',
  'drift-as-flaky',
  'cascading-env',
  'other',
] as const;
export type BoundaryType = (typeof BOUNDARY_TYPES)[number];

const screenshotMetaSchema = z.object({
  count: z.number().int().nonnegative(),
  dimensions: z.array(
    z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  ),
  capturedAtOffsetMs: z.array(z.number().nonnegative()),
});

const historicalFailureRateSchema = z.object({
  failedInLastNRuns: z.number().int().nonnegative(),
  totalRuns: z.number().int().positive(),
});

/** A curated, hard-boundary test case with human-verified ground truth.
 * `payload` is exactly what the classifier sees (reuses failurePayloadSchema
 * so this can never silently drift from the live FailurePayload shape); the
 * remaining fields are dataset-only context, never sent to the model. */
export const goldenCaseSchema = z.object({
  id: z.string().min(1),
  payload: failurePayloadSchema,
  historicalFailureRate: historicalFailureRateSchema.optional(),
  screenshots: screenshotMetaSchema.optional(),
  humanClass: failureClassSchema,
  boundaryType: z.enum(BOUNDARY_TYPES),
  note: z.string().min(1),
});

export type GoldenCase = z.infer<typeof goldenCaseSchema>;

/** Missing/empty directory returns []. Malformed content throws loud,
 * naming the offending file — a silently-skipped bad case would corrupt
 * the eval:golden report without anyone noticing (mirrors readDataset in
 * src/groundTruth.ts). */
export function readGoldenCases(dir: string): GoldenCase[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const path = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}: not valid JSON: ${message}`, { cause: error });
    }
    const result = goldenCaseSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`${path}: failed schema validation: ${issues}`);
    }
    return result.data;
  });
}

/** Writes <dir>/<case.id>.json, creating dir if needed, and returns the path.
 * Validates before writing — readGoldenCases is strict, so a malformed case
 * must fail here, at write time, not surface later as an opaque throw from
 * the next read pointing at a file this same code just wrote. */
export function writeGoldenCase(dir: string, goldenCase: GoldenCase): string {
  const validated = goldenCaseSchema.parse(goldenCase);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${validated.id}.json`);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
  return path;
}
