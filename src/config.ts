import { z } from 'zod';

import type { AiTriageOptions } from './types.js';

const OUTPUTS = ['stdout', 'github', 'slack'] as const;

const optionsSchema = z.object({
  model: z.string().default('claude-haiku-4-5'), // verified alias, ADR-0003
  outputs: z.array(z.enum(OUTPUTS)).nonempty().optional(),
  includeDom: z.boolean().default(false),
  maxFailures: z.number().int().positive().default(25),
  dryRun: z.boolean().default(false),
  failSilently: z.boolean().default(true),
});

const KNOWN_KEYS = new Set(Object.keys(optionsSchema.shape));

// Playwright injects internals into every reporter's options object —
// they must never trigger the typo warning or invalidate real options.
// (`configDir` today; anything _-prefixed is treated as internal.)
const isPlaywrightInternal = (key: string) => key === 'configDir' || key.startsWith('_');

export interface ResolvedConfig {
  model: string;
  outputs: (typeof OUTPUTS)[number][];
  includeDom: boolean;
  maxFailures: number;
  dryRun: boolean;
  failSilently: boolean;
  apiKey: string | undefined;
  githubToken: string | undefined;
  slackWebhookUrl: string | undefined;
  diffSummary: string | undefined;
}

type Env = Record<string, string | undefined>;

function autoDetectOutputs(env: Env): ResolvedConfig['outputs'] {
  const outputs: ResolvedConfig['outputs'] = ['stdout'];
  if (env.GITHUB_ACTIONS === 'true') outputs.push('github');
  if (env.SLACK_WEBHOOK_URL) outputs.push('slack');
  return outputs;
}

/** Options + env → full config. Invalid options warn and fall back to defaults — never throws. */
export function resolveConfig(
  options: AiTriageOptions = {},
  env: Env = process.env,
  warn: (message: string) => void = console.warn,
): ResolvedConfig {
  // typo'd option names warn (but never nuke the valid options alongside them)
  const unknownKeys = Object.keys(options).filter(
    (key) => !KNOWN_KEYS.has(key) && !isPlaywrightInternal(key),
  );
  if (unknownKeys.length > 0) {
    warn(`[playwright-ai-triage] unknown option(s) ignored: ${unknownKeys.join(', ')}`);
  }

  const parsed = optionsSchema.safeParse(options);
  let opts: z.infer<typeof optionsSchema>;
  if (parsed.success) {
    opts = parsed.data;
  } else {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    warn(`[playwright-ai-triage] invalid options, using defaults (${issues})`);
    opts = optionsSchema.parse({});
  }

  return {
    model: opts.model,
    outputs: [...new Set(opts.outputs ?? autoDetectOutputs(env))],
    includeDom: opts.includeDom,
    maxFailures: opts.maxFailures,
    dryRun: opts.dryRun,
    failSilently: opts.failSilently,
    apiKey: env.ANTHROPIC_API_KEY,
    githubToken: env.GITHUB_TOKEN,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    diffSummary: env.GIT_DIFF_SUMMARY,
  };
}
