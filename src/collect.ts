import fs from 'node:fs';
import path from 'node:path';

import type { TestCase, TestResult, TestStep } from '@playwright/test/reporter';

import { failedRequestsFrom } from './network.js';
import { redact } from './redact.js';
import type { FailurePayload, FailureRetry } from './types.js';

const BUDGET = {
  error: 2000,
  stack: 2000,
  dom: 1500,
  diff: 1000,
  retryError: 300,
  failedRequests: 8,
  url: 300,
} as const;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** chars of an over-budget aria snapshot kept from the top, for page identity */
const SNAPSHOT_HEAD = 300;

/**
 * Truncate an aria snapshot from the MIDDLE, not the end.
 *
 * An aria snapshot is ordered top-of-page first, so `truncate` keeps the banner
 * and nav — the part identical on every page — and drops the part that says why
 * the test failed. Measured on a ~3000-char snapshot, the spinner, the loading
 * text and the error dialog all sat past a 1500-char head: the model read the
 * surviving chrome as "the page loaded" and lowered its confidence.
 *
 * A short head still earns its place — "which page is this" is evidence too
 * (a login page under a checkout test is a session-expiry signal). The elision
 * is marked so the model never reads a fragment as the whole page.
 */
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

export function truncateSnapshot(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (elided: number) => `\n… [${elided} chars elided] …\n`;
  // elided < text.length, so a marker sized for text.length is never too small
  const markerLength = marker(text.length).length;
  // no budget for even the marker: fall back to a plain cut rather than overshoot
  if (max <= markerLength) return truncate(text, max);
  // a budget too small for head + marker must still honour `max`; the head yields first
  const headLength = Math.max(0, Math.min(SNAPSHOT_HEAD, max - markerLength));
  const tailLength = Math.max(0, max - headLength - markerLength);

  let head = text.slice(0, headLength);
  // a cut between a surrogate pair leaves a lone half in the JSON sent to the API
  if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
  let tail = tailLength > 0 ? text.slice(text.length - tailLength) : '';
  if (isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);

  return `${head}${marker(text.length - head.length - tail.length)}${tail}`;
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

  // Not gated on includeDom: a status line is an endpoint and a number, with the
  // query string already dropped — it carries none of the page content that made
  // the DOM snippet opt-in, and it is the evidence a UI-side backend failure needs.
  const failedRequests = failedRequestsFrom(result)?.slice(0, BUDGET.failedRequests);

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
    ...(domSnippet ? { domSnippet: truncateSnapshot(clean(domSnippet), BUDGET.dom) } : {}),
    ...(failedRequests?.length
      ? {
          failedRequests: failedRequests.map((r) => ({
            ...r,
            url: truncate(clean(r.url), BUDGET.url),
          })),
        }
      : {}),
    ...(options.diffSummary
      ? { diffSummary: truncate(clean(options.diffSummary), BUDGET.diff) }
      : {}),
    duration: result.duration,
  };
}
