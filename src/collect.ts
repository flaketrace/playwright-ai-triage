import fs from 'node:fs';

import type { TestCase, TestResult, TestStep } from '@playwright/test/reporter';

import { redact } from './redact.js';
import type { FailurePayload, FailureRetry } from './types.js';

const BUDGET = { error: 2000, stack: 2000, dom: 1500, diff: 1000 } as const;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Playwright colourises assertion errors (SGR escapes like `\x1b[2m`); those
// codes are ~20% of the raw error text and pure noise to the classifier — strip
// them before redaction so the model (and any secret pattern) sees clean text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

function stripNodeModulesFrames(stack: string): string {
  return stack
    .split('\n')
    .filter((line) => !line.includes('node_modules'))
    .join('\n');
}

/** Deepest failed step title — the most specific action that broke. */
function deepestFailedStep(steps: TestStep[]): string | undefined {
  for (const step of steps) {
    if (!step.error) continue;
    return deepestFailedStep(step.steps ?? []) ?? step.title;
  }
  return undefined;
}

/**
 * Extract the `# Page snapshot` section from Playwright's auto-attached
 * error-context markdown (aria snapshot). Absent/malformed → undefined.
 */
function domSnippetFrom(result: TestResult): string | undefined {
  const attachment = result.attachments.find(
    (a) => a.name === 'error-context' && a.contentType === 'text/markdown',
  );
  if (!attachment) return undefined;
  try {
    const md = attachment.body
      ? attachment.body.toString('utf8')
      : attachment.path
        ? fs.readFileSync(attachment.path, 'utf8')
        : undefined;
    if (!md) return undefined;
    // Current format (Playwright ≳1.53): the aria snapshot is a fenced ```yaml
    // block. It is the only yaml block in error-context (error details are a bare
    // ``` block, test source is ```ts).
    const yaml = md.match(/```ya?ml\s*\n([\s\S]*?)```/i);
    if (yaml?.[1]) return yaml[1].trim() || undefined;
    // Legacy format: a `# Page snapshot` section (kept for older Playwright).
    const match = md.match(/^# Page snapshot\s*$/im);
    if (!match || match.index === undefined) return undefined;
    const rest = md.slice(match.index + match[0].length);
    const nextHeading = rest.search(/^# /m);
    const snapshot = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
    return snapshot || undefined;
  } catch {
    return undefined;
  }
}

export interface CollectOptions {
  includeDom: boolean;
  diffSummary: string | undefined;
}

type Env = Record<string, string | undefined>;

export function collectFailure(
  test: TestCase,
  result: TestResult,
  options: CollectOptions,
  env: Env = process.env,
): FailurePayload {
  const clean = (text: string) => redact(stripAnsi(text), env);

  const errorMessage = result.errors
    .map((e) => e.message ?? '')
    .filter(Boolean)
    .join('\n\n');
  const stack = result.errors.find((e) => e.stack)?.stack ?? '';

  const retries: FailureRetry[] = test.results.map((r) => ({
    attempt: r.retry,
    status: r.status,
  }));

  const domSnippet = options.includeDom ? domSnippetFrom(result) : undefined;

  const failingStep = deepestFailedStep(result.steps);

  return {
    testId: test.id,
    // titles and step titles can interpolate runtime values — redact like all free text
    title: truncate(clean(test.title), BUDGET.error),
    file: test.location.file,
    line: test.location.line,
    errorMessage: truncate(clean(errorMessage), BUDGET.error),
    stack: truncate(clean(stripNodeModulesFrames(stack)), BUDGET.stack),
    ...(failingStep ? { failingStep: truncate(clean(failingStep), BUDGET.error) } : {}),
    retries,
    retryThenPassed: test.outcome() === 'flaky',
    ...(domSnippet ? { domSnippet: truncate(clean(domSnippet), BUDGET.dom) } : {}),
    ...(options.diffSummary
      ? { diffSummary: truncate(clean(options.diffSummary), BUDGET.diff) }
      : {}),
    duration: result.duration,
  };
}
