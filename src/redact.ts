const MASK = '[REDACTED]';

const PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/g, // Anthropic / OpenAI style keys ("desk-..." must not match)
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub classic tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
];

const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;

/** Env values shorter than this are too likely to collide with ordinary words. */
const MIN_ENV_VALUE_LENGTH = 8;

/**
 * Mask secret-looking tokens and any secret-named env-var values in free text.
 * Pure: the env source is a parameter (defaults to process.env at the call site).
 */
export function redact(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  out = out.replace(BEARER, `$1${MASK}`);
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
    out = out.split(value).join(MASK);
  }
  return out;
}
