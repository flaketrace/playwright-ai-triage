import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectGithubContext,
  fetchPreviousComment,
  postGithubComment,
  type FetchLike,
} from '../src/render/github.js';

const env = (overrides: Record<string, string | undefined> = {}) => ({
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_REF: 'refs/pull/42/merge',
  GITHUB_TOKEN: 'gh-test-token',
  ...overrides,
});

type FetchMock = ReturnType<typeof vi.fn> & FetchLike;

function fetchMock(existingComments: { id: number; body: string }[] = []): FetchMock {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    if (!init?.method || init.method === 'GET') {
      return { ok: true, status: 200, json: async () => existingComments };
    }
    return { ok: true, status: init.method === 'POST' ? 201 : 200, json: async () => ({}) };
  }) as FetchMock;
}

describe('detectGithubContext', () => {
  it('resolves repo + PR number from GITHUB_REF', () => {
    const ctx = detectGithubContext(env());
    expect(ctx).toMatchObject({ repo: 'owner/repo', prNumber: 42 });
  });

  it('falls back to the event payload when the ref is not a PR ref', () => {
    const eventPath = path.join(os.tmpdir(), `evt-${process.pid}.json`);
    fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
    const ctx = detectGithubContext(
      env({ GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: eventPath }),
    );
    expect(ctx).toMatchObject({ prNumber: 7 });
    fs.unlinkSync(eventPath);
  });

  it.each([
    ['no repository', { GITHUB_REPOSITORY: undefined }],
    ['no token', { GITHUB_TOKEN: undefined }],
    ['no PR context', { GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: undefined }],
  ])('skips with a reason when %s', (_name, overrides) => {
    const ctx = detectGithubContext(env(overrides));
    expect(ctx).toHaveProperty('skipReason');
  });
});

describe('postGithubComment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a new comment when no marker match exists', async () => {
    const f = fetchMock([{ id: 1, body: 'unrelated' }]);
    const res = await postGithubComment('**summary**', null, env(), f);
    expect(res.ok).toBe(true);
    const postCall = f.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(postCall![0]).toContain('/repos/owner/repo/issues/42/comments');
    expect(JSON.parse(postCall![1].body).body).toContain('<!-- playwright-ai-triage -->');
  });

  it('updates its own comment when the marker matches (upsert, never spam)', async () => {
    const f = fetchMock([
      { id: 5, body: '<!-- playwright-ai-triage -->\nold summary' },
      { id: 6, body: 'someone else' },
    ]);
    const res = await postGithubComment('new summary', null, env(), f);
    expect(res.ok).toBe(true);
    const patch = f.mock.calls.find((c) => c[1]?.method === 'PATCH');
    expect(patch![0]).toContain('/repos/owner/repo/issues/comments/5');
    expect(f.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });

  it('scopes the marker per shard so shards do not clobber each other', async () => {
    const f = fetchMock([{ id: 9, body: '<!-- playwright-ai-triage:shard-1/3 -->\nshard one' }]);
    const res = await postGithubComment('shard two summary', { current: 2, total: 3 }, env(), f);
    expect(res.ok).toBe(true);
    const post = f.mock.calls.find((c) => c[1]?.method === 'POST');
    expect(JSON.parse(post![1].body).body).toContain('<!-- playwright-ai-triage:shard-2/3 -->');
  });

  it('finds its marker beyond the first page of comments (no duplicate spam)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: `noise ${i}` }));
    const page2 = [{ id: 200, body: '<!-- playwright-ai-triage -->\nold' }];
    const f = vi.fn(async (url: string, init?: { method?: string }) => {
      if (!init?.method || init.method === 'GET') {
        const page = Number(url.match(/[&?]page=(\d+)$/)?.[1] ?? 1);
        return {
          ok: true,
          status: 200,
          json: async () => (page === 1 ? page1 : page2),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as FetchMock;
    const res = await postGithubComment('updated', null, env(), f);
    expect(res.ok).toBe(true);
    const patch = f.mock.calls.find((c) => c[1]?.method === 'PATCH');
    expect(patch![0]).toContain('/issues/comments/200');
    expect(f.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });

  it('fails open with a permissions hint on 403', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })) as FetchMock;
    const res = await postGithubComment('s', null, env(), f);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.note).toMatch(/pull-requests: write/);
  });

  it('fails open when fetch itself throws', async () => {
    const f = vi.fn(async () => {
      throw new Error('ENOTFOUND api.github.com');
    }) as unknown as FetchMock;
    const res = await postGithubComment('s', null, env(), f);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.note).toMatch(/ENOTFOUND/);
  });

  it('skips silently-with-reason outside PR context', async () => {
    const f = fetchMock();
    const res = await postGithubComment('s', null, env({ GITHUB_REF: 'refs/heads/main' }), f);
    expect(res.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('appends the fingerprint block after the markdown when fingerprints are given', async () => {
    const f = fetchMock();
    await postGithubComment('**summary**', null, env(), f, {
      fingerprints: ['3f9a1c2b4d5e', '90ab12cd34ef'],
    });
    const post = f.mock.calls.find((c) => c[1]?.method === 'POST');
    const body = JSON.parse(post![1].body).body as string;
    expect(body).toMatch(
      /\*\*summary\*\*\n<!-- playwright-ai-triage:fps:v1 3f9a1c2b4d5e 90ab12cd34ef -->$/,
    );
  });

  it('omits the fingerprint block rather than blow the GitHub 65,536-char body cap', async () => {
    const f = fetchMock();
    // renderer budgets markdown to ~60k; a catastrophic run's fingerprint set must
    // not push the total over the API cap (422 ⇒ no comment at all on the worst runs)
    const markdown = 'x'.repeat(59_990);
    const fingerprints = Array.from({ length: 600 }, (_, i) =>
      `${i}`.padStart(12, 'a').slice(0, 12),
    );
    const res = await postGithubComment(markdown, null, env(), f, { fingerprints });
    expect(res.ok).toBe(true);
    const body = JSON.parse(f.mock.calls.find((c) => c[1]?.method === 'POST')![1].body)
      .body as string;
    expect(body.length).toBeLessThan(65_536);
    expect(body).not.toContain(':fps:v1'); // no block beats a truncated (false-RESOLVED) block
    expect(body).toContain('x'.repeat(100)); // markdown itself untouched
  });

  it('PATCHes the given comment directly without re-listing when existing is provided', async () => {
    const f = fetchMock();
    const res = await postGithubComment('updated', null, env(), f, { existing: { id: 77 } });
    expect(res.ok).toBe(true);
    expect(f.mock.calls.some((c) => !c[1]?.method || c[1].method === 'GET')).toBe(false);
    const patch = f.mock.calls.find((c) => c[1]?.method === 'PATCH');
    expect(patch![0]).toContain('/issues/comments/77');
  });

  it('POSTs directly without re-listing when existing is null (caller already searched)', async () => {
    const f = fetchMock([{ id: 5, body: '<!-- playwright-ai-triage -->\nwould match' }]);
    const res = await postGithubComment('fresh', null, env(), f, { existing: null });
    expect(res.ok).toBe(true);
    expect(f.mock.calls.some((c) => !c[1]?.method || c[1].method === 'GET')).toBe(false);
    expect(f.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(true);
  });
});

describe('fetchPreviousComment', () => {
  it('returns the marker-matching comment with its body', async () => {
    const f = fetchMock([
      { id: 3, body: 'unrelated' },
      {
        id: 5,
        body: '<!-- playwright-ai-triage -->\nold\n<!-- playwright-ai-triage:fps:v1 3f9a1c2b4d5e -->',
      },
    ]);
    const res = await fetchPreviousComment(null, env(), f);
    expect(res).toMatchObject({ found: { id: 5 } });
    expect('found' in res && res.found?.body).toContain(':fps:v1 3f9a1c2b4d5e');
  });

  it('returns found: undefined when no own comment exists', async () => {
    const res = await fetchPreviousComment(null, env(), fetchMock([{ id: 1, body: 'noise' }]));
    expect(res).toEqual({ found: undefined });
  });

  it('scopes the search by shard marker', async () => {
    const f = fetchMock([{ id: 9, body: '<!-- playwright-ai-triage:shard-1/3 -->\nshard one' }]);
    const res = await fetchPreviousComment({ current: 2, total: 3 }, env(), f);
    expect(res).toEqual({ found: undefined });
    const scoped = await fetchPreviousComment({ current: 1, total: 3 }, env(), f);
    expect(scoped).toMatchObject({ found: { id: 9 } });
  });

  it('finds the comment beyond the first page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: `noise ${i}` }));
    const page2 = [{ id: 200, body: '<!-- playwright-ai-triage -->\nold' }];
    const f = vi.fn(async (url: string) => {
      const page = Number(url.match(/[&?]page=(\d+)$/)?.[1] ?? 1);
      return { ok: true, status: 200, json: async () => (page === 1 ? page1 : page2) };
    }) as unknown as FetchMock;
    const res = await fetchPreviousComment(null, env(), f);
    expect(res).toMatchObject({ found: { id: 200 } });
  });

  it('returns a skipReason outside PR context without calling the API', async () => {
    const f = fetchMock();
    const res = await fetchPreviousComment(null, env({ GITHUB_REF: 'refs/heads/main' }), f);
    expect(res).toHaveProperty('skipReason');
    expect(f).not.toHaveBeenCalled();
  });

  it('returns a skipReason instead of throwing when the API fails', async () => {
    const f = vi.fn(async () => {
      throw new Error('ENOTFOUND api.github.com');
    }) as unknown as FetchMock;
    const res = await fetchPreviousComment(null, env(), f);
    expect(res).toHaveProperty('skipReason');
  });
});
