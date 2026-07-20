import fs from 'node:fs';
import path from 'node:path';

import type { TestCase, TestResult, TestStep } from '@playwright/test/reporter';

import { redact } from './redact.js';
import type { FailurePayload, FailureRetry } from './types.js';

const BUDGET = { error: 2000, stack: 2000, dom: 1500, diff: 1000, retryError: 300 } as const;

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
 * Extract the aria snapshot from Playwright's auto-attached error-context
 * markdown. Absent/malformed → undefined.
 *
 * One Playwright version emits BOTH layouts depending on the assertion that
 * failed — captured from 1.61.1: a locator timeout writes the snapshot as an
 * unheaded ```yaml fence, while a `toMatchAriaSnapshot` mismatch writes it
 * under a `# Page snapshot` heading. So neither shape is "legacy", and keying on
 * the heading alone would have dropped the snapshot for the captured locator
 * timeout — the case where it is most wanted (drift vs flake).
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
    // Take the first ```yaml fence. This relies on the snapshot being the only
    // yaml-tagged fence present: error details are bare-fenced and test source is
    // ```ts. Checked on 1.61.1 for a locator timeout and a toMatchAriaSnapshot
    // mismatch — notably the latter renders an aria DIFF inside error details,
    // which looks like a snapshot but is bare-fenced, so first-match skips it.
    // Two assertion types is not a proof for every failure mode; if a document
    // ever carries an earlier yaml fence, prefer locating `# Page snapshot` first.
    const yaml = md.match(/```ya?ml\s*\n([\s\S]*?)```/i);
    if (yaml?.[1]) return yaml[1].trim() || undefined;
    // Defensive: a `# Page snapshot` section whose body is not yaml-fenced. No
    // captured sample of this shape — it is a cheap guard, not a documented format.
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
  /** Playwright's config.rootDir; when set, finding paths render repo-relative */
  rootDir?: string;
}

// Findings render CI-runner-absolute paths without this; relative paths are
// shorter and match how the repo's own files are referenced in a PR. Files
// outside rootDir (or on another Windows drive) keep the absolute path — a
// wrong relative path is worse than a long absolute one.
function relativizePath(file: string, rootDir: string | undefined): string {
  if (!rootDir) return file;
  const rel = path.relative(rootDir, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join('/');
}

type Env = Record<string, string | undefined>;

export function collectFailure(
  test: TestCase,
  result: TestResult,
  options: CollectOptions,
  env: Env = process.env,
): FailurePayload {
  const clean = (text: string) => redact(stripAnsi(text), env);

  const joinErrors = (errors: { message?: string }[] | undefined) =>
    (errors ?? [])
      .map((e) => e.message ?? '')
      .filter(Boolean)
      .join('\n\n');

  const errorMessage = joinErrors(result.errors);
  const stack = result.errors.find((e) => e.stack)?.stack ?? '';

  // Prior attempts keep a short error head: without it the model sees only the
  // final attempt's error (e.g. a bare timeout) and loses the earlier attempts'
  // signal (e.g. the 500s that preceded it). Skipped when the CLEANED text
  // repeats the reported attempt's — a repeat (even one differing only by ANSI
  // codes or a rotated secret) carries no signal beyond its status, only token
  // cost.
  const cleanedReported = clean(errorMessage);
  const retries: FailureRetry[] = test.results.map((r) => {
    const raw = r.retry === result.retry ? '' : joinErrors(r.errors);
    const cleaned = raw ? clean(raw) : '';
    return {
      attempt: r.retry,
      status: r.status,
      ...(cleaned && cleaned !== cleanedReported
        ? { errorHead: truncate(cleaned, BUDGET.retryError) }
        : {}),
    };
  });

  const domSnippet = options.includeDom ? domSnippetFrom(result) : undefined;

  const failingStep = deepestFailedStep(result.steps);

  return {
    testId: test.id,
    // titles and step titles can interpolate runtime values — redact like all free text
    title: truncate(clean(test.title), BUDGET.error),
    file: relativizePath(test.location.file, options.rootDir),
    line: test.location.line,
    errorMessage: truncate(cleanedReported, BUDGET.error),
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
