import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import { classifyFailures, type ClassifierClient, type StickyClassMap } from './classify.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { collectFailure } from './collect.js';
import { computeDelta, parseFingerprintBlock, type FingerprintEntry } from './delta.js';
import { failureFingerprint } from './fingerprint.js';
import {
  renderAllClearSummary,
  renderMarkdownSummary,
  type DeltaContext,
} from './render/markdown.js';
import {
  detectGithubContext,
  fetchPreviousComment,
  postGithubComment,
  type FetchPreviousResult,
} from './render/github.js';
import { buildSlackPayload, postSlackMessage } from './render/slack.js';
import { buildSinkEnvelope, postToSink } from './sink.js';
import { renderPlainSummary, renderStdoutSummary } from './summary.js';
import type { AiTriageOptions, Classification, FailurePayload } from './types.js';

const TAG = '[playwright-ai-triage]';

/** Map the previous comment's fingerprint block to per-test delta labels (R3). */
function deltaContext(
  previous: FetchPreviousResult,
  fingerprintByTestId: Record<string, string>,
): { delta?: DeltaContext } {
  if ('skipReason' in previous || !previous.found) return {};
  const previousEntries = parseFingerprintBlock(previous.found.body);
  const delta = computeDelta(
    Object.values(fingerprintByTestId),
    previousEntries === null ? null : previousEntries.map((e) => e.fingerprint),
  );
  if (!delta) return {}; // pre-block comment: no delta info, render unlabeled
  const labelByTestId: DeltaContext['labelByTestId'] = {};
  for (const [testId, fp] of Object.entries(fingerprintByTestId)) {
    const label = delta.labels.get(fp);
    if (label) labelByTestId[testId] = label;
  }
  return { delta: { labelByTestId, resolvedCount: delta.resolvedCount } };
}

type FetchLike = Parameters<typeof postGithubComment>[3];

interface Internals {
  client?: ClassifierClient;
  fetchImpl?: FetchLike;
}

/**
 * Playwright reporter that classifies test failures with an LLM.
 *
 * Invariant: the reporter never throws out of a hook and never alters the
 * run's exit status — `onEnd` always resolves to undefined (a returned status
 * object would override the exit code), and every async path is awaited
 * inside the try/catch below.
 */
export default class AiTriageReporter implements Reporter {
  private readonly options: AiTriageOptions;
  private readonly internals: Internals;
  private config: ResolvedConfig | undefined;
  private shard: { current: number; total: number } | null = null;
  private rootDir: string | undefined;
  private failures = new Map<string, { test: TestCase; result: TestResult }>();

  constructor(options: AiTriageOptions = {}, internals: Internals = {}) {
    this.options = options;
    this.internals = internals;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    try {
      this.config = resolveConfig(this.options);
      this.shard = config.shard ?? null;
      this.rootDir = config.rootDir;
    } catch (error) {
      this.warnInternal(error);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    try {
      if (result.status === 'failed' || result.status === 'timedOut') {
        // keep the last failing attempt per test — retry history comes from test.results
        this.failures.set(test.id, { test, result });
      }
    } catch (error) {
      this.warnInternal(error);
    }
  }

  async onEnd(_result: FullResult): Promise<undefined> {
    try {
      const config = (this.config ??= resolveConfig(this.options));

      // outcome() is only final here: 'expected' covers test.fail() annotations —
      // those are green-by-design and must not be triaged (or billed).
      const entries = [...this.failures.values()].filter(({ test }) => {
        const outcome = test.outcome();
        return outcome === 'unexpected' || outcome === 'flaky';
      });
      if (entries.length === 0) {
        console.log(`${TAG} no failures to triage.`);
        // A green run still posts an empty-failures envelope: run presence is
        // data (a consumer can't otherwise tell "all green" from "no run").
        await this.postSink([], null, config);
        // R1: fixed ⇒ gone — a green run flips our previous red comment to all-clear
        await this.flipToAllClear(config);
        return undefined;
      }

      const payloads = entries.map(({ test, result }) =>
        collectFailure(test, result, {
          includeDom: config.includeDom,
          diffSummary: config.diffSummary,
          ...(this.rootDir ? { rootDir: this.rootDir } : {}),
        }),
      );

      // R2/D6 (ADR-0012): runs that will write class-carrying state into the PR
      // comment fetch the previous comment FIRST — persisting fingerprints reuse
      // their stored class (no API call), and fresh fingerprints are classified
      // by majority-of-3 before their class gets frozen into the block. Keyless
      // and dryRun runs never freeze classes, so they neither fetch nor vote.
      // detectGithubContext keeps scheduled/push CI runs (github output enabled,
      // but no PR to hold state) on single draws — voting there would triple
      // token spend with nothing ever frozen. A transient fetch failure on a
      // real PR keeps voting on: the block may still post via the upsert search.
      const stickyEligible =
        config.outputs.includes('github') &&
        Boolean(config.apiKey) &&
        !config.dryRun &&
        !('skipReason' in detectGithubContext(process.env));
      let previous: FetchPreviousResult | undefined;
      let sticky: StickyClassMap | undefined;
      if (stickyEligible) {
        previous = await fetchPreviousComment(this.shard, process.env, this.internals.fetchImpl);
        if (!('skipReason' in previous) && previous.found) {
          const previousEntries = parseFingerprintBlock(previous.found.body);
          if (previousEntries) {
            sticky = new Map(
              previousEntries
                .filter(
                  (e): e is Required<FingerprintEntry> =>
                    e.class !== undefined && e.confidence !== undefined,
                )
                .map((e) => [e.fingerprint, { class: e.class, confidence: e.confidence }]),
            );
          }
        }
      }

      const { classified, costUsd, notes } = await classifyFailures(payloads, config, {
        ...(this.internals.client ? { client: this.internals.client } : {}),
        ...(sticky ? { sticky } : {}),
        ...(stickyEligible ? { vote: true } : {}),
      });

      await this.postSink(classified, costUsd ?? null, config);

      if (!config.apiKey && !config.dryRun) {
        // Keyless: deterministic local verdicts still classify for free
        // (classifyFailures never calls the API without a key); show the full
        // summary when any exist, else the plain hint. Rich outputs stay off —
        // a mostly-UNCLASSIFIED PR comment is noise, not triage.
        const anyLocal = classified.some((c) => c.classification.class !== 'UNCLASSIFIED');
        console.log(
          anyLocal
            ? // model: null — keyless runs make no API calls, so the cost line names none
              renderStdoutSummary(classified, costUsd, notes, null)
            : renderPlainSummary(payloads),
        );
        if (config.outputs.includes('github') || config.outputs.includes('slack')) {
          console.warn(
            `${TAG} github/slack outputs skipped — set ANTHROPIC_API_KEY to enable classification first`,
          );
        }
        return undefined;
      }

      const projectByTestId: Record<string, string> = {};
      for (const { test } of entries) {
        const project = test.parent?.project?.()?.name;
        if (project) projectByTestId[test.id] = project;
      }
      const renderContext = {
        model: config.model,
        costUsd,
        notes,
        shard: this.shard,
        projectByTestId,
      };

      if (config.outputs.includes('stdout')) {
        console.log(renderStdoutSummary(classified, costUsd, notes, config.model));
      } else {
        const triaged = classified.filter((c) => c.classification.class !== 'UNCLASSIFIED').length;
        console.log(`${TAG} triaged ${triaged} of ${classified.length} failure(s).`);
      }
      if (config.dryRun) console.log(`${TAG} dry-run mode — no API calls were made.`);

      if (config.outputs.includes('github')) {
        // R3: the previous comment's fingerprint block is the only cross-run
        // state — already fetched above on sticky-eligible runs, fetched here
        // otherwise (dryRun posts too, with a class-less block).
        const prev =
          previous ??
          (await fetchPreviousComment(this.shard, process.env, this.internals.fetchImpl));
        const fingerprintByTestId: Record<string, string> = {};
        for (const { payload } of classified) {
          fingerprintByTestId[payload.testId] = failureFingerprint(payload);
        }
        const markdown = renderMarkdownSummary(classified, {
          ...renderContext,
          ...deltaContext(prev, fingerprintByTestId),
        });
        // dryRun must not freeze fixture classes into state a later real run
        // would reuse — its block carries bare fingerprints (delta still works).
        const blockEntries: FingerprintEntry[] = classified.map(({ payload, classification }) => ({
          fingerprint: fingerprintByTestId[payload.testId]!,
          ...(config.dryRun
            ? {}
            : { class: classification.class, confidence: classification.confidence }),
        }));
        const result = await postGithubComment(
          markdown,
          this.shard,
          process.env,
          this.internals.fetchImpl,
          {
            fingerprints: blockEntries,
            ...('found' in prev ? { existing: prev.found ?? null } : {}),
          },
        );
        if (!result.ok) console.warn(`${TAG} github output skipped: ${result.note}`);
      }

      if (config.outputs.includes('slack')) {
        if (config.slackWebhookUrl) {
          const payload = buildSlackPayload(classified, renderContext);
          const result = await postSlackMessage(
            payload,
            config.slackWebhookUrl,
            this.internals.fetchImpl,
          );
          if (!result.ok) console.warn(`${TAG} slack output skipped: ${result.note}`);
        } else {
          console.warn(`${TAG} slack output skipped: SLACK_WEBHOOK_URL is not set`);
        }
      }
    } catch (error) {
      this.warnInternal(error);
    }
    return undefined;
  }

  printsToStdio(): boolean {
    return true;
  }

  /**
   * The sink fires on keyed AND keyless runs (statuses and fingerprints are
   * useful data either way) and on green runs (empty failures — run presence is
   * data), but never in dryRun: demo runs must not POST fixture data to a real
   * endpoint. A sink failure warns and never affects the run.
   */
  private async postSink(
    classified: { payload: FailurePayload; classification: Classification }[],
    costUsd: number | null,
    config: ResolvedConfig,
  ): Promise<void> {
    if (!config.sinkUrl || config.dryRun) return;
    const envelope = buildSinkEnvelope(
      classified,
      costUsd,
      this.shard,
      process.env,
      config.apiKey ? config.model : null,
    );
    const result = await postToSink(
      envelope,
      config.sinkUrl,
      config.sinkToken,
      this.internals.fetchImpl,
    );
    if (!result.ok) console.warn(`${TAG} sink output skipped: ${result.note}`);
  }

  /**
   * R1: on a green run, PATCH our previous red comment to an all-clear state.
   * Zero-noise rules: never POST (a PR that never had failures gets no comment),
   * never rewrite an already-all-clear comment, and stay off the API entirely in
   * keyless mode (mirrors the red path's github gating).
   */
  private async flipToAllClear(config: ResolvedConfig): Promise<void> {
    if (!config.outputs.includes('github')) return;
    if (!config.apiKey && !config.dryRun) return;

    const previous = await fetchPreviousComment(this.shard, process.env, this.internals.fetchImpl);
    if ('skipReason' in previous || !previous.found) return;

    const previousFps = parseFingerprintBlock(previous.found.body);
    if (previousFps !== null && previousFps.length === 0) return; // already all clear

    const markdown = renderAllClearSummary(
      previousFps === null ? null : previousFps.length,
      this.shard,
    );
    const result = await postGithubComment(
      markdown,
      this.shard,
      process.env,
      this.internals.fetchImpl,
      { existing: previous.found, fingerprints: [] },
    );
    if (!result.ok) console.warn(`${TAG} github all-clear update skipped: ${result.note}`);
  }

  private warnInternal(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${TAG} internal error (your build is unaffected): ${message}`);
    if (this.config && !this.config.failSilently && this.config.outputs.includes('github')) {
      // GitHub annotation format: newlines must be %0A-encoded
      const encoded = message.replace(/\r/g, '').replace(/\n/g, '%0A');
      console.log(`::warning title=playwright-ai-triage::internal error: ${encoded}`);
    }
  }
}

export type {
  AiTriageOptions,
  Classification,
  FailureClass,
  FailurePayload,
  FailureRetry,
} from './types.js';

export { failureFingerprint, normalizeErrorSignature } from './fingerprint.js';
