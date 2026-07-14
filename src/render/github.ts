import fs from 'node:fs';

import { renderFingerprintBlock } from '../delta.js';

type Env = Record<string, string | undefined>;
type Shard = { current: number; total: number } | null;
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type SendResult = { ok: true } | { ok: false; note: string };

/** GitHub rejects issue-comment bodies over 65,536 chars; stay safely under. */
const MAX_COMMENT_CHARS = 65_000;

interface GithubContext {
  repo: string;
  prNumber: number;
  apiUrl: string;
  token: string;
}

export function detectGithubContext(env: Env): GithubContext | { skipReason: string } {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) return { skipReason: 'GITHUB_REPOSITORY is not set (not running in Actions?)' };
  const token = env.GITHUB_TOKEN;
  if (!token) return { skipReason: 'GITHUB_TOKEN is not set — cannot post a PR comment' };

  let prNumber: number | undefined;
  const refMatch = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//);
  if (refMatch) prNumber = Number(refMatch[1]);
  if (prNumber === undefined && env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as {
        pull_request?: { number?: number };
      };
      prNumber = event.pull_request?.number;
    } catch {
      // fall through to the skip below
    }
  }
  if (prNumber === undefined) {
    return { skipReason: 'no pull request context (push/schedule event?) — PR comment skipped' };
  }

  return { repo, prNumber, token, apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com' };
}

function markerFor(shard: Shard): string {
  return shard
    ? `<!-- playwright-ai-triage:shard-${shard.current}/${shard.total} -->`
    : '<!-- playwright-ai-triage -->';
}

export interface PreviousComment {
  id: number;
  body: string;
}

export type FetchPreviousResult = { found: PreviousComment | undefined } | { skipReason: string };

/**
 * Find our (shard-scoped) previous comment on the PR, body included — the body
 * carries the R3 fingerprint block the next render diffs against. Never throws.
 */
export async function fetchPreviousComment(
  shard: Shard,
  env: Env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<FetchPreviousResult> {
  const context = detectGithubContext(env);
  if ('skipReason' in context) return { skipReason: context.skipReason };

  const headers = {
    authorization: `Bearer ${context.token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };

  try {
    const own = await findOwnComment(context, markerFor(shard), headers, fetchImpl);
    if ('note' in own) return { skipReason: own.note };
    return { found: own.comment };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipReason: `GitHub comment lookup failed: ${message}` };
  }
}

/** Walk up to 3 pages for the marker-carrying comment; busy PRs can hold >100 comments. */
async function findOwnComment(
  context: GithubContext,
  marker: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<{ comment: PreviousComment | undefined } | { note: string }> {
  const base = `${context.apiUrl}/repos/${context.repo}/issues`;
  for (let page = 1; page <= 3; page += 1) {
    const listRes = await fetchImpl(
      `${base}/${context.prNumber}/comments?per_page=100&page=${page}`,
      { headers },
    );
    if (!listRes.ok) return { note: failureNote('listing PR comments', listRes.status) };
    const comments = (await listRes.json()) as { id: number; body?: string }[];
    const own = comments.find((c) => c.body?.includes(marker));
    if (own) return { comment: { id: own.id, body: own.body ?? '' } };
    if (comments.length < 100) break;
  }
  return { comment: undefined };
}

export interface PostOptions {
  /**
   * Prior search result from fetchPreviousComment: an object PATCHes that comment
   * directly, `null` means "already searched, none found" (POST directly), and
   * `undefined` makes this function run the marker search itself.
   */
  existing?: { id: number } | null;
  /** R3 state: appended after the markdown as an invisible fingerprint block. */
  fingerprints?: string[];
}

/**
 * Upsert our PR comment: find the comment carrying our (shard-scoped) marker and
 * update it; otherwise create one. Never throws — every failure is a note.
 */
export async function postGithubComment(
  markdown: string,
  shard: Shard,
  env: Env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  opts: PostOptions = {},
): Promise<SendResult> {
  const context = detectGithubContext(env);
  if ('skipReason' in context) return { ok: false, note: context.skipReason };

  const marker = markerFor(shard);
  const block = opts.fingerprints ? `\n${renderFingerprintBlock(opts.fingerprints)}` : '';
  let body = `${marker}\n${markdown}${block}`;
  // GitHub caps comment bodies at 65,536 chars. The markdown is budgeted upstream,
  // but the block scales with failure count — on a catastrophic run, omit the whole
  // block rather than 422 (no comment at all) or truncate it (a partial block would
  // fake RESOLVED next run; a missing one merely degrades to unlabeled).
  if (block && body.length > MAX_COMMENT_CHARS) body = `${marker}\n${markdown}`;
  const headers = {
    authorization: `Bearer ${context.token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };
  const base = `${context.apiUrl}/repos/${context.repo}/issues`;

  try {
    let own: { id: number } | undefined;
    if (opts.existing === undefined) {
      const search = await findOwnComment(context, marker, headers, fetchImpl);
      if ('note' in search) return { ok: false, note: search.note };
      own = search.comment;
    } else {
      own = opts.existing ?? undefined;
    }

    const res = own
      ? await fetchImpl(`${base}/comments/${own.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ body }),
        })
      : await fetchImpl(`${base}/${context.prNumber}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ body }),
        });
    if (!res.ok) return { ok: false, note: failureNote('posting the PR comment', res.status) };
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, note: `GitHub PR comment failed: ${message}` };
  }
}

function failureNote(action: string, status: number): string {
  const hint =
    status === 403 ? ' — the workflow token likely lacks `permissions: pull-requests: write`' : '';
  return `GitHub API ${status} while ${action}${hint}`;
}
