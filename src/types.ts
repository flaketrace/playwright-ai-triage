/** One attempt in a test's retry history. */
export interface FailureRetry {
  attempt: number;
  status: 'failed' | 'passed' | 'timedOut' | 'skipped' | 'interrupted';
  /**
   * head of this attempt's error text (redacted, truncated to 300 chars);
   * present only for attempts other than the reported one whose error text
   * differs from the reported error — the reported attempt's error is already
   * the payload's errorMessage, and an identical repeat carries no signal
   * beyond its status
   */
  errorHead?: string;
}

/** Everything the classifier is allowed to see about one failed test. */
export interface FailurePayload {
  testId: string;
  title: string;
  file: string;
  line: number;
  /** truncated to 2000 chars */
  errorMessage: string;
  /** truncated to 2000 chars, node_modules frames stripped */
  stack: string;
  /** deepest failed step title along the first failing chain */
  failingStep?: string;
  retries: FailureRetry[];
  /** computed from retries; a strong FLAKY prior */
  retryThenPassed: boolean;
  /** deterministic pre-pass signal, passed to the model as evidence, not a verdict */
  heuristicPrior?: 'FLAKY' | 'ENV_ISSUE';
  /** opt-in via `includeDom`, truncated to 1500 chars, redacted */
  domSnippet?: string;
  /** opt-in only, via the GIT_DIFF_SUMMARY env var; absent when unset; truncated to 1000 chars */
  diffSummary?: string;
  duration: number;
}

export type FailureClass = 'REAL_BUG' | 'FLAKY' | 'SELECTOR_DRIFT' | 'ENV_ISSUE' | 'UNCLASSIFIED';

/** Schema-validated classifier output; anything that fails validation becomes UNCLASSIFIED. */
export interface Classification {
  class: FailureClass;
  /** 0..1 */
  confidence: number;
  /** one sentence, human-readable, citing evidence from the payload */
  why: string;
  /**
   * SELECTOR_DRIFT: concrete locator suggestion; config-type ENV_ISSUE: the
   * environment variable / feature flag to check; REAL_BUG when diffSummary
   * shows the diff confined to the test's own file/helper (prompt rule 5):
   * name that file/helper and point at verifying its recent change against
   * live behavior. Absent otherwise.
   */
  suggestedFix?: string;
}

/** The full reporter option surface. Env: ANTHROPIC_API_KEY, GITHUB_TOKEN, SLACK_WEBHOOK_URL. */
export interface AiTriageOptions {
  /** classifier model; defaults to the current Haiku alias */
  model?: string;
  /** default: auto-detected (GitHub Actions env => 'github'; SLACK_WEBHOOK_URL => 'slack'; always 'stdout') */
  outputs?: ('stdout' | 'github' | 'slack')[];
  /** send a redacted DOM snippet with each failure; default false */
  includeDom?: boolean;
  /**
   * send at most this many failures to the API per run (default 25). Failures
   * classified locally by heuristics don't consume this budget; overflow is
   * reported honestly as UNCLASSIFIED.
   */
  maxFailures?: number;
  /** fixture classifications, no API call — for demos and CI of the examples project */
  dryRun?: boolean;
  /**
   * default true. `false` additionally surfaces internal reporter errors as CI warning
   * annotations. The reporter never fails the build either way.
   */
  failSilently?: boolean;
}
