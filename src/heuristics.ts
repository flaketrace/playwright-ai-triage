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
];

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
    // A timeout wrapping a network error is not "purely network" — the model decides.
    if (TIMEOUT_WORDING.test(text)) return { prior: 'ENV_ISSUE' };
    return {
      prior: 'ENV_ISSUE',
      verdict: {
        class: 'ENV_ISSUE',
        confidence: 0.95,
        why: 'pure network failure signature — classified locally without an API call',
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
