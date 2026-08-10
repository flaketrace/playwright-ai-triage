import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { redact } from '../src/redact.js';
import { goldenCaseSchema, writeGoldenCase, type GoldenCase } from './schema.js';

export type RedactionKind = 'EMAIL' | 'HOST' | 'PATH' | 'TOKEN';

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_PATTERN = /https?:\/\/[^\s/'")]+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Bare hostnames without a scheme (e.g. "getaddrinfo ENOTFOUND payments-api.acme-corp.internal") —
// URL_PATTERN only catches http(s):// forms, so a dotted-domain-shaped token needs its own pass.
// A generic "word.word" match, and even a TLD-suffix-anchored match, is unsafe:
// short generic suffixes (io/dev/app/co/test/local) collide with ordinary code
// identifiers (console.info, RegExp.test, db.local), and no finite TLD list
// covers every real ccTLD (.de, .uk, .cloud, ...) without either over- or
// under-redacting. Gated on context instead: only a dotted token immediately
// following a DNS/network-error keyword — the shape Node's own network errors
// actually take — counts as a hostname. Narrower true-positive net, but a
// false negative here is caught by the tool's other passes plus the
// mandatory human diff review; a false positive corrupts case fidelity with
// no way for a reviewer to notice short of re-typing the original.
// Lookbehind (not a capture group) so the match is the hostname alone —
// the keyword that gated it stays in the output, only the host is replaced.
// Final label must START with a letter (a real TLD/suffix never starts with
// a digit) so a version or duration string right after one of these
// keywords — "ETIMEDOUT 30.5s elapsed", "ECONNRESET v18.20.4 node" — isn't
// mistaken for a host; bare IPs are already handled by the IPV4 pass above.
// Requiring the final label to be PURELY alphabetic (no trailing digit)
// would instead garble punycode/IDN TLDs (".xn--p1ai") mid-label, leaving
// visible residue in the output — an alphabetic start is enough to reject
// digit-led version numbers without that corruption.
const BARE_HOSTNAME =
  /(?<=\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|getaddrinfo)\s)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?/g;
// Absolute paths rooted at known filesystem locations (a maintainer's home
// directory, or a common local/CI/container checkout root) — not "any
// absolute path with 2+ segments", which is indistinguishable from a URL
// route like /api/v1/orders or /checkout/session/create appearing in
// ordinary error text. "github" covers GitHub Actions' /github/workspace
// container root.
//
// The leading `/` is anchored to a real path-start boundary (start of
// string, preceded by whitespace/quote/paren/colon/equals, OR preceded by
// "file://" — Node ESM stack frames and ERR_MODULE_NOT_FOUND messages use
// file:/// URLs, whose extra slashes would otherwise block the lookbehind
// entirely and leak the whole path unredacted) via the negative lookbehind.
// Without the boundary anchor at all, an UNLISTED root whose path happens to
// contain a LISTED segment produces a silent partial leak: "/mnt/ci/workspace/…"
// would match starting mid-string at "/workspace/…", redacting the tail
// while leaving "/mnt/ci" — the actually-identifying part — untouched, and
// worse, reading as if the whole line had been sanitized.
const UNIX_PATH =
  /(?:(?<![^\s'"(:=])|(?<=file:\/\/))\/(?:Users|home|builds|var|opt|workspace|srv|runner|root|tmp|app|usr|data|github)\/[^\s'":]+/g;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\s'":\\]+\\)*[^\s'":\\]+/g;

/**
 * Two-pass redaction: (1) reuse src/redact.ts's already-vetted secret-token
 * patterns (API keys, GitHub/Slack tokens, AWS keys, Bearer values, and any
 * env value whose var name looks secret-shaped) so this tool never
 * re-derives that list and drifts from it; (2) this tool's own PII patterns
 * (email/host/IP/path), which src/redact.ts has no reason to know about
 * since it runs on live classifier input, not archival dataset text.
 */
export function redactText(
  text: string,
  env: Record<string, string | undefined>,
): { redacted: string; hits: RedactionKind[] } {
  const hits: RedactionKind[] = [];

  const afterSecrets = redact(text, env);
  let out = afterSecrets === text ? text : afterSecrets.split('[REDACTED]').join('<TOKEN>');
  if (out !== text) hits.push('TOKEN');

  const passes: { pattern: RegExp; kind: RedactionKind }[] = [
    { pattern: EMAIL, kind: 'EMAIL' },
    { pattern: URL_PATTERN, kind: 'HOST' },
    { pattern: IPV4, kind: 'HOST' },
    // Paths run before the bare-hostname pass: a file path's extension
    // (e.g. "index.ts") is itself a dotted, hostname-shaped token, so
    // matching paths first keeps the hostname pass from eating it.
    { pattern: UNIX_PATH, kind: 'PATH' },
    { pattern: WINDOWS_PATH, kind: 'PATH' },
    { pattern: BARE_HOSTNAME, kind: 'HOST' },
  ];
  for (const { pattern, kind } of passes) {
    const placeholder = kind === 'HOST' ? '<HOST>' : kind === 'PATH' ? '<PATH>' : '<EMAIL>';
    const before = out;
    out = out.replace(pattern, placeholder);
    if (out !== before) hits.push(kind);
  }

  return { redacted: out, hits };
}

export interface FieldDiff {
  field: string;
  before: string;
  after: string;
  hits: RedactionKind[];
}

interface FieldAccessor {
  name: string;
  get: (c: GoldenCase) => string | undefined;
  set: (c: GoldenCase, v: string) => void;
}

const FIELDS: FieldAccessor[] = [
  {
    name: 'payload.title',
    get: (c) => c.payload.title,
    set: (c, v) => {
      c.payload.title = v;
    },
  },
  {
    name: 'payload.file',
    get: (c) => c.payload.file,
    set: (c, v) => {
      c.payload.file = v;
    },
  },
  {
    name: 'payload.errorMessage',
    get: (c) => c.payload.errorMessage,
    set: (c, v) => {
      c.payload.errorMessage = v;
    },
  },
  {
    name: 'payload.stack',
    get: (c) => c.payload.stack,
    set: (c, v) => {
      c.payload.stack = v;
    },
  },
  {
    name: 'payload.failingStep',
    get: (c) => c.payload.failingStep,
    set: (c, v) => {
      c.payload.failingStep = v;
    },
  },
  {
    name: 'payload.diffSummary',
    get: (c) => c.payload.diffSummary,
    set: (c, v) => {
      c.payload.diffSummary = v;
    },
  },
  // domSnippet is free-form HTML and just as likely to carry hrefs/emails as
  // any other free-text field — redacted even though it wasn't spelled out
  // in the original field list, on the same reasoning as the other fields.
  {
    name: 'payload.domSnippet',
    get: (c) => c.payload.domSnippet,
    set: (c, v) => {
      c.payload.domSnippet = v;
    },
  },
  {
    name: 'note',
    get: (c) => c.note,
    set: (c, v) => {
      c.note = v;
    },
  },
];

/** Validates raw input against goldenCaseSchema, redacts every free-text
 * field, and returns the cleaned case plus a diff per field that changed.
 * `synthetic` is a required field with no default, so the raw input must
 * set it explicitly either way — but this tool exists for the real-case
 * path (see evals/README.md's "How cases are collected and labeled"), so
 * a maintainer preparing a raw case here should set `synthetic: false`.
 * Not enforced by the schema itself: nothing here rejects `true`. */
export function redactCase(
  raw: unknown,
  env: Record<string, string | undefined>,
): { case: GoldenCase; diffs: FieldDiff[] } {
  const parsed = goldenCaseSchema.parse(raw);
  const cleaned: GoldenCase = JSON.parse(JSON.stringify(parsed));
  const diffs: FieldDiff[] = [];

  for (const field of FIELDS) {
    const before = field.get(parsed);
    if (before === undefined) continue;
    const { redacted, hits } = redactText(before, env);
    if (redacted === before) continue;
    field.set(cleaned, redacted);
    diffs.push({ field: field.name, before, after: redacted, hits });
  }

  // failedRequests[].url is a structured field, not free text, but
  // src/types.ts documents it as retaining hostname and port — the one
  // structured field carrying a raw host, so it needs the same HOST pass
  // as the free-text fields above or a case with captured network failures
  // would publish unredacted hosts despite the tool's own banner promising
  // host redaction.
  if (cleaned.payload.failedRequests) {
    cleaned.payload.failedRequests.forEach((request, index) => {
      const before = request.url;
      const { redacted, hits } = redactText(before, env);
      if (redacted === before) return;
      request.url = redacted;
      diffs.push({ field: `payload.failedRequests[${index}].url`, before, after: redacted, hits });
    });
  }

  return { case: goldenCaseSchema.parse(cleaned), diffs };
}

export interface RunAnonymizeDeps {
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  casesDir?: string;
}

const DEFAULT_CASES_DIR = fileURLToPath(new URL('./golden/cases', import.meta.url));

export async function runAnonymize(argv: string[], deps: RunAnonymizeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const casesDir = deps.casesDir ?? DEFAULT_CASES_DIR;

  const write = argv.includes('--write');
  const inputPath = argv.find((a) => !a.startsWith('--'));
  if (!inputPath) {
    errorLog('Usage: anonymize <input-case.json> [--write]');
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFile(inputPath));
  } catch (error) {
    errorLog(
      `failed to read/parse ${inputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  let result: { case: GoldenCase; diffs: FieldDiff[] };
  try {
    result = redactCase(raw, env);
  } catch (error) {
    errorLog(
      `${inputPath} does not match the GoldenCase schema: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  log('Regex catches technical PII (hosts/emails/tokens/paths) only — it does NOT catch');
  log('domain-specific identifiers (internal service/feature names, business terms) that');
  log('could indirectly identify a source project. Review every diff below by hand before');
  log('using --write.');
  log('');

  if (result.diffs.length === 0) {
    log(`${inputPath}: no redactions triggered.`);
  } else {
    for (const diff of result.diffs) {
      log(`[${diff.field}] ${diff.hits.length} redaction(s): ${diff.hits.join(', ')}`);
      log(`- ${diff.before}`);
      log(`+ ${diff.after}`);
      log('');
    }
  }

  if (!write) {
    log('Dry run only — nothing written. Re-run with --write after reviewing the diff above.');
    return 0;
  }

  if (deps.writeFile) {
    const path = `${casesDir}/${result.case.id}.json`;
    deps.writeFile(path, `${JSON.stringify(result.case, null, 2)}\n`);
    log(`Wrote ${path}`);
  } else {
    const path = writeGoldenCase(casesDir, result.case);
    log(`Wrote ${path}`);
  }
  return 0;
}

// realpathSync-resolved: import.meta.url resolves through a symlink to the
// REAL path, but process.argv[1] does not — a plain-path comparison here
// silently never fires under a symlinked invocation (see src/cli.ts).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  runAnonymize(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
