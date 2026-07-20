import { failureFingerprint } from './fingerprint.js';
import type { ClassifiedFailure } from './classify.js';
import type { Classification, FailurePayload } from './types.js';

// Deliberately its own fetch type: unlike the GitHub/Slack ones it accepts an
// abort signal (the sink talks to an arbitrary user endpoint, so a hung server
// must not stall the run past the timeout). The reporter's injected fetchImpl
// remains assignable — extra optional init fields narrow, they don't conflict.
type SinkFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

export interface SinkFailure {
  fingerprint: string;
  payload: FailurePayload;
  classification: Classification;
  /** present (true) when the class was reused from the previous run's block (R2 sticky) */
  reused?: boolean;
  /** per-draw results when vote-on-first ran (D6) — consumers get real distributions */
  draws?: { class: Classification['class']; confidence: number }[];
}

export interface SinkEnvelope {
  /** compatibility contract — bump only with a schema change */
  schema: 'ai-triage-sink/v1';
  reporter: 'playwright-ai-triage';
  createdAt: string;
  run: {
    shard: { current: number; total: number } | null;
    repository?: string;
    branch?: string;
    commit?: string;
    prNumber?: number;
  };
  summary: {
    failures: number;
    counts: Record<Classification['class'], number>;
    costUsd: number | null;
    /** classifier model, or null when the run made no API calls (keyless) */
    model: string | null;
  };
  failures: SinkFailure[];
}

export function buildSinkEnvelope(
  classified: ClassifiedFailure[],
  costUsd: number | null,
  shard: { current: number; total: number } | null,
  env: Env,
  model: string | null,
): SinkEnvelope {
  const counts: SinkEnvelope['summary']['counts'] = {
    REAL_BUG: 0,
    FLAKY: 0,
    SELECTOR_DRIFT: 0,
    ENV_ISSUE: 0,
    UNCLASSIFIED: 0,
  };
  for (const { classification } of classified) counts[classification.class] += 1;

  const prMatch = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//);
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;

  return {
    schema: 'ai-triage-sink/v1',
    reporter: 'playwright-ai-triage',
    createdAt: new Date().toISOString(),
    run: {
      shard,
      ...(env.GITHUB_REPOSITORY ? { repository: env.GITHUB_REPOSITORY } : {}),
      ...(branch ? { branch } : {}),
      ...(env.GITHUB_SHA ? { commit: env.GITHUB_SHA } : {}),
      ...(prMatch ? { prNumber: Number(prMatch[1]) } : {}),
    },
    summary: { failures: classified.length, counts, costUsd, model },
    failures: classified.map(({ payload, classification, reused, draws }) => ({
      fingerprint: failureFingerprint(payload),
      payload,
      classification,
      ...(reused ? { reused: true } : {}),
      ...(draws?.length ? { draws } : {}),
    })),
  };
}

export async function postToSink(
  envelope: SinkEnvelope,
  sinkUrl: string,
  sinkToken: string | undefined,
  fetchImpl: SinkFetchLike = fetch as unknown as SinkFetchLike,
): Promise<{ ok: true } | { ok: false; note: string }> {
  try {
    const response = await fetchImpl(sinkUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sinkToken ? { authorization: `Bearer ${sinkToken}` } : {}),
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, note: `sink responded ${response.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, note: error instanceof Error ? error.message : String(error) };
  }
}
