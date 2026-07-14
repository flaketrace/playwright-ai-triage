import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { ResolvedConfig } from './config.js';
import { heuristicFor } from './heuristics.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import type { Classification, FailurePayload } from './types.js';

/** USD per 1M tokens — Anthropic reference, cached 2026-06-24 (ADR-0003). */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5': { input: 3, output: 15 },
};

const BATCH_SIZE = 10;
const MAX_OUTPUT_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 60_000;

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

export interface ClassifiedFailure {
  payload: FailurePayload;
  classification: Classification;
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
  deps: { client?: ClassifierClient } = {},
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

  // Budget cap: overflow is honestly unclassified, never silently dropped.
  const capped = toModel.slice(0, config.maxFailures);
  const overflow = toModel.slice(config.maxFailures);
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

  for (const batch of chunk(capped, BATCH_SIZE)) {
    try {
      const response = await client.messages.parse({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(batch) }],
        output_config: { format: zodOutputFormat(responseSchema) },
      });
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
