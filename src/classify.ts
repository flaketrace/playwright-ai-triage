import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { ResolvedConfig } from './config.js';
import { failureFingerprint } from './fingerprint.js';
import { heuristicFor } from './heuristics.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import type { Classification, FailureClass, FailurePayload } from './types.js';

/** USD per 1M tokens — Anthropic reference, cached 2026-06-24 (ADR-0003). */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5': { input: 3, output: 15 },
};

const BATCH_SIZE = 10;
const MAX_OUTPUT_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 60_000;
/** D6: draws per batch when the caller enables voting — the reporter turns it
 * on for runs that freeze classes into the PR block (ADR-0012). */
const VOTE_DRAWS = 3;

const responseSchema = z.object({
  classifications: z.array(
    z.object({
      testId: z.string(),
      class: z.enum(['REAL_BUG', 'FLAKY', 'SELECTOR_DRIFT', 'ENV_ISSUE', 'UNCLASSIFIED']),
      confidence: z.number(),
      why: z.string(),
      suggestedFix: z.string().optional(),
    }),
  ),
});

/** The slice of the Anthropic client we use — injectable for tests. */
export interface ClassifierClient {
  messages: {
    parse: (params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string }[];
      output_config: { format: unknown };
    }) => Promise<{
      parsed_output: z.infer<typeof responseSchema> | null;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string | null;
    }>;
  };
}

/** Prior classifications by fingerprint, parsed from the previous PR comment's fps:v2 block. */
export type StickyClassMap = Map<string, { class: FailureClass; confidence: number }>;

export interface ClassifiedFailure {
  payload: FailurePayload;
  classification: Classification;
  /** true when the class was reused from the previous run's block (R2 sticky) — no API call */
  reused?: boolean;
  /** per-draw results when vote-on-first ran (D6) — the recorded class is their majority */
  draws?: { class: FailureClass; confidence: number }[];
}

export interface ClassifyResult {
  classified: ClassifiedFailure[];
  /** undefined when the model's pricing is unknown */
  costUsd: number | undefined;
  /** honest degradation notes for the summary */
  notes: string[];
  /** entries beyond the maxFailures budget — listed as UNCLASSIFIED but not "triaged" */
  overflowCount: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const unclassified = (payload: FailurePayload, why: string): ClassifiedFailure => ({
  payload,
  classification: { class: 'UNCLASSIFIED', confidence: 0, why },
});

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function classifyFailures(
  payloads: FailurePayload[],
  config: ResolvedConfig,
  deps: { client?: ClassifierClient; sticky?: StickyClassMap; vote?: boolean } = {},
): Promise<ClassifyResult> {
  const notes: string[] = [];
  const classified: ClassifiedFailure[] = [];

  // Heuristic pre-pass: attach priors (on copies — inputs stay caller-owned);
  // script-decidable failures (retry-then-passed, pure network, expired credentials)
  // are classified locally and never reach the API.
  const toModel: FailurePayload[] = [];
  let localCount = 0;
  for (const original of payloads) {
    const heuristic = heuristicFor(original);
    const payload = heuristic.prior ? { ...original, heuristicPrior: heuristic.prior } : original;
    if (heuristic.verdict) {
      localCount += 1;
      classified.push({
        payload,
        classification: {
          class: heuristic.verdict.class,
          confidence: heuristic.verdict.confidence,
          why: heuristic.verdict.why,
        },
      });
    } else {
      toModel.push(payload);
    }
  }
  if (localCount > 0 && !config.dryRun) {
    notes.push(
      `${localCount} failure(s) classified locally by deterministic rules — no tokens spent`,
    );
  }

  if (config.dryRun) {
    for (const payload of toModel) {
      classified.push({
        payload,
        classification: {
          class: payload.heuristicPrior ?? 'UNCLASSIFIED',
          confidence: payload.heuristicPrior ? 0.5 : 0,
          why: 'dry-run fixture classification (no API call)',
        },
      });
    }
    return { classified, costUsd: 0, notes, overflowCount: 0 };
  }

  // Sticky reuse (R2, ADR-0012): a PERSISTING fingerprint keeps the class the
  // previous run recorded in the PR comment's fps:v2 block — the classification
  // is a draw from a distribution, and redrawing a known failure risks flipping
  // its class for no reason. Rules (D2): heuristic verdicts above already won;
  // stored UNCLASSIFIED never persists (fail-closed states are not verdicts);
  // keyed runs only (keyless/dryRun have no block to honor — the apiKey check
  // is defense in depth, orchestration never passes sticky on those paths).
  // Reused failures skip the maxFailures budget: reuse is free.
  const remaining: FailurePayload[] = [];
  let reusedCount = 0;
  const sticky = config.apiKey ? deps.sticky : undefined;
  for (const payload of toModel) {
    const prior = sticky?.get(failureFingerprint(payload));
    if (prior && prior.class !== 'UNCLASSIFIED') {
      reusedCount += 1;
      classified.push({
        payload,
        classification: {
          class: prior.class,
          // same last-line defense as model output: the block parser guarantees
          // 0..1 today, but StickyClassMap is a public type
          confidence: clamp01(prior.confidence),
          why: 'same failure as the previous run — classification reused, no API call',
        },
        reused: true,
      });
    } else {
      remaining.push(payload);
    }
  }
  if (reusedCount > 0) {
    notes.push(`${reusedCount} persisting failure(s) reused prior classification — no API call`);
  }

  // Budget cap: overflow is honestly unclassified, never silently dropped.
  const capped = remaining.slice(0, config.maxFailures);
  const overflow = remaining.slice(config.maxFailures);
  if (overflow.length > 0) {
    notes.push(
      `${overflow.length} failure(s) beyond the maxFailures cap (${config.maxFailures}) were not classified`,
    );
    for (const payload of overflow) {
      classified.push(unclassified(payload, 'beyond the maxFailures budget cap'));
    }
  }

  if (capped.length === 0) return { classified, costUsd: 0, notes, overflowCount: overflow.length };

  if (!config.apiKey) {
    notes.push(
      `ANTHROPIC_API_KEY is not set — ${capped.length} failure(s) left unclassified (https://console.anthropic.com/)`,
    );
    for (const payload of capped) classified.push(unclassified(payload, 'no API key available'));
    return { classified, costUsd: 0, notes, overflowCount: overflow.length };
  }

  const client: ClassifierClient =
    deps.client ??
    // narrowed structural view of the SDK client (its parse signature is generic-heavy)
    (new Anthropic({
      apiKey: config.apiKey,
      maxRetries: 2, // built-in exponential backoff; honors retry-after on 429
      timeout: REQUEST_TIMEOUT_MS,
    }) as unknown as ClassifierClient);

  let inputTokens = 0;
  let outputTokens = 0;

  const callModel = (batch: FailurePayload[]) =>
    client.messages.parse({
      model: config.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(batch) }],
      output_config: { format: zodOutputFormat(responseSchema) },
    });

  for (const batch of chunk(capped, BATCH_SIZE)) {
    if (deps.vote) {
      // D6 vote-on-first: three independent draws per batch, majority per payload.
      // A failed/refused draw contributes nothing (majority over what survived);
      // zero surviving draws falls back to the single-draw failure semantics.
      const settled = await Promise.allSettled(
        Array.from({ length: VOTE_DRAWS }, () => callModel(batch)),
      );
      const drawMaps: Map<string, z.infer<typeof responseSchema>['classifications'][number]>[] = [];
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          const message =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          notes.push(`classifier API error on a vote draw: ${message}`);
          continue;
        }
        const response = outcome.value;
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
        if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
          notes.push(`classifier response ${response.stop_reason} on a vote draw — draw skipped`);
          continue;
        }
        if (response.parsed_output === null) {
          notes.push('classifier returned no schema-valid output for a vote draw');
          continue;
        }
        drawMaps.push(new Map(response.parsed_output.classifications.map((c) => [c.testId, c])));
      }

      if (drawMaps.length === 0) {
        for (const payload of batch) classified.push(unclassified(payload, 'classifier API error'));
        continue;
      }

      for (const payload of batch) {
        const draws = drawMaps
          .map((m) => m.get(payload.testId))
          .filter((d): d is NonNullable<typeof d> => d !== undefined);
        if (draws.length === 0) {
          classified.push(unclassified(payload, 'no schema-valid classification returned'));
          continue;
        }
        const counts = new Map<FailureClass, number>();
        for (const d of draws) counts.set(d.class, (counts.get(d.class) ?? 0) + 1);
        const [topClass, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
        const drawRecord = draws.map((d) => ({
          class: d.class,
          confidence: clamp01(d.confidence),
        }));
        if (topCount * 2 <= draws.length) {
          // no strict majority (e.g. a 3-way split) — fail closed, never a coin flip
          const split = draws.map((d) => d.class).join(' / ');
          classified.push({
            ...unclassified(payload, `no majority across ${draws.length} draws (${split})`),
            draws: drawRecord,
          });
          continue;
        }
        const majority = draws.filter((d) => d.class === topClass);
        const confidence =
          majority.reduce((sum, d) => sum + clamp01(d.confidence), 0) / majority.length;
        // why AND suggestedFix come from the same draw — mixing draws could pair
        // reasoning with a fix citing different evidence (e.g. two locators)
        const lead = majority[0]!;
        classified.push({
          payload,
          classification: {
            class: topClass,
            confidence,
            why: lead.why,
            ...(lead.suggestedFix ? { suggestedFix: lead.suggestedFix } : {}),
          },
          draws: drawRecord,
        });
      }
      continue;
    }

    try {
      const response = await callModel(batch);
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
        notes.push(`classifier response ${response.stop_reason} — batch left unclassified`);
        for (const payload of batch) {
          classified.push(unclassified(payload, `classifier ${response.stop_reason}`));
        }
        continue;
      }

      const byId = new Map(
        (response.parsed_output?.classifications ?? []).map((c) => [c.testId, c]),
      );
      for (const payload of batch) {
        const match = byId.get(payload.testId);
        if (!match) {
          classified.push(unclassified(payload, 'no schema-valid classification returned'));
          continue;
        }
        classified.push({
          payload,
          classification: {
            class: match.class,
            confidence: clamp01(match.confidence),
            why: match.why,
            ...(match.suggestedFix ? { suggestedFix: match.suggestedFix } : {}),
          },
        });
      }
      if (response.parsed_output === null) {
        notes.push('classifier returned no schema-valid output for a batch');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`classifier API error after retries: ${message}`);
      for (const payload of batch) classified.push(unclassified(payload, 'classifier API error'));
    }
  }

  const pricing = Object.entries(PRICING).find(([prefix]) => config.model.startsWith(prefix))?.[1];
  const costUsd = pricing
    ? (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output
    : undefined;

  return { classified, costUsd, notes, overflowCount: overflow.length };
}
