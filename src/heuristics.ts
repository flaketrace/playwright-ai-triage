import type { FailurePayload } from './types.js';

/** A classification decided locally by deterministic rules — no API call, no tokens. */
export interface LocalVerdict {
  class: 'FLAKY' | 'ENV_ISSUE';
  confidence: number;
  why: string;
}

/** Deterministic pre-pass result. Priors are evidence for the model, not verdicts. */
export interface HeuristicResult {
  prior?: 'FLAKY' | 'ENV_ISSUE';
  /** present = classify locally without an API call */
  verdict?: LocalVerdict;
}

const NETWORK_SIGNATURES = [
  /net::ERR_[A-Z_]+/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ENOTFOUND/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /upstream connect error/i,
  /disconnect\/reset before headers/i,
];

// The suite's own transient-retry machinery is an explicit ENV signal: when the
// test wrapped a status in TransientHttpError, exhausted a retryOnTransient budget,
// or reported "HTTP 5xx/409 after N attempts", the authors already deemed that
// status transient infrastructure — not a defect in the behavior under test. A bare
// 5xx without that wrapper is left to the model (it could be the endpoint under test).
const TRANSIENT_RETRY_WORDING =
  /TransientHttpError|retryOnTransient|HTTP (5\d\d|409) after \d+ attempts/i;

// Explicit credential-expiry wording (e.g. Azure DevOps: "The Personal Access Token
// used has expired."). An expired credential is test-infrastructure state, never an
// app defect — but a *generic* 401/403 can be a real bug, so only the expiry wording
// short-circuits; bare auth failures still reach the model.
const EXPIRED_CREDENTIAL_WORDING =
  /(personal access token|access token|api key|credential|certificate)[^\n]{0,60}\bexpired\b|\bexpired\b[^\n]{0,60}(personal access token|access token|api key|credential|certificate)/i;

// Assertion-failure wording (expect() diffs) — evidence the failure is about app
// state, so credential-expiry text inside it is content under test, not infra.
const ASSERTION_WORDING = /expect\(|Expected:|Received:|toBe|toHaveText|toBeVisible/;

// The drift-vs-flaky hard case — must always reach the model. Deliberately broad:
// covers locator waits, web-first assertion polls ("Timed out Nms waiting for expect"),
// test-level "Test timeout of Nms exceeded", and generic TimeoutError.
const TIMEOUT_WORDING =
  /waiting for (locator|selector|element|getBy|expect)|TimeoutError|Timeout( of)? \d+ms exceeded|Timed out \d+ms/i;

export function heuristicFor(
  payload: Pick<FailurePayload, 'errorMessage' | 'stack' | 'retryThenPassed'>,
): HeuristicResult {
  // Passed on retry: the run itself proved the failure is not reproducible — that is
  // the definition of FLAKY, decidable by script. No model judgment adds anything.
  if (payload.retryThenPassed) {
    return {
      prior: 'FLAKY',
      verdict: {
        class: 'FLAKY',
        confidence: 0.9,
        why: 'failed, then passed on retry — deterministic flaky signal; classified locally without an API call',
      },
    };
  }

  const text = `${payload.errorMessage}\n${payload.stack}`;

  if (NETWORK_SIGNATURES.some((re) => re.test(text))) {
    // A timeout wrapping a network error — or a network phrase quoted inside an
    // assertion (a test asserting on that text) — is not "purely network": defer to
    // the model with an ENV prior instead of a local verdict.
    if (TIMEOUT_WORDING.test(text) || ASSERTION_WORDING.test(text)) return { prior: 'ENV_ISSUE' };
    return {
      prior: 'ENV_ISSUE',
      verdict: {
        class: 'ENV_ISSUE',
        confidence: 0.95,
        why: 'pure network failure signature — classified locally without an API call',
      },
    };
  }

  // The suite's transient-retry wording is a script-decidable ENV signal (the test
  // itself deemed the status transient). Exclude assertion wording: a test asserting
  // ON a TransientHttpError/5xx response is talking about app content, not infra.
  if (TRANSIENT_RETRY_WORDING.test(text) && !ASSERTION_WORDING.test(text)) {
    return {
      prior: 'ENV_ISSUE',
      verdict: {
        class: 'ENV_ISSUE',
        confidence: 0.85,
        why: 'the suite\'s own transient-retry helper already treated this status as transient infrastructure (TransientHttpError / retried "after N attempts") — classified locally without an API call',
      },
    };
  }

  // Expiry wording inside an assertion or timeout is the app/test talking about
  // expiry (e.g. a test asserting an "expired token" banner), not infrastructure
  // rejecting a credential — those must reach the model.
  if (
    EXPIRED_CREDENTIAL_WORDING.test(text) &&
    !TIMEOUT_WORDING.test(text) &&
    !ASSERTION_WORDING.test(text)
  ) {
    return {
      prior: 'ENV_ISSUE',
      verdict: {
        class: 'ENV_ISSUE',
        confidence: 0.9,
        why: 'explicit expired-credential wording — infrastructure state, not an app or test defect; classified locally without an API call',
      },
    };
  }

  return {};
}
