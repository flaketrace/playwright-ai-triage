import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { redact } from '../src/redact.js';
import { goldenCaseSchema, type GoldenCase } from './schema.js';

export type RedactionKind = 'EMAIL' | 'HOST' | 'PATH' | 'TOKEN';

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_PATTERN = /https?:\/\/[^\s/'")]+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const UNIX_PATH = /\/(?:Users|home)\/[^\s'":]+/g;
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
    { pattern: UNIX_PATH, kind: 'PATH' },
    { pattern: WINDOWS_PATH, kind: 'PATH' },
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
 * field, and returns the cleaned case plus a diff per field that changed. */
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

const DEFAULT_CASES_DIR = 'evals/golden/cases';

export async function runAnonymize(argv: string[], deps: RunAnonymizeDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console.log;
  const errorLog = deps.errorLog ?? console.error;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const casesDir = deps.casesDir ?? DEFAULT_CASES_DIR;
  const writeFile =
    deps.writeFile ??
    ((path: string, content: string) => {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, content);
    });

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

  const path = join(casesDir, `${result.case.id}.json`);
  writeFile(path, `${JSON.stringify(result.case, null, 2)}\n`);
  log(`Wrote ${path}`);
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
