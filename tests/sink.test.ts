import { describe, expect, it, vi } from 'vitest';

import { failureFingerprint } from '../src/fingerprint.js';
import { buildSinkEnvelope, postToSink } from '../src/sink.js';
import type { Classification, FailurePayload } from '../src/types.js';

function payload(testId: string, overrides: Partial<FailurePayload> = {}): FailurePayload {
  return {
    testId,
    title: `test ${testId}`,
    file: 'tests/a.spec.ts',
    line: 3,
    errorMessage: `boom in ${testId}`,
    stack: '',
    retries: [{ attempt: 0, status: 'failed' }],
    retryThenPassed: false,
    duration: 100,
    ...overrides,
  };
}

const classification = (overrides: Partial<Classification> = {}): Classification => ({
  class: 'REAL_BUG',
  confidence: 0.9,
  why: 'assertion mismatch',
  ...overrides,
});

describe('buildSinkEnvelope', () => {
  it('carries reused and draws provenance when present, omits them otherwise (schema v1 additive)', () => {
    const classified = [
      {
        payload: payload('a'),
        classification: classification({ class: 'ENV_ISSUE' }),
        reused: true,
      },
      {
        payload: payload('b'),
        classification: classification(),
        draws: [
          { class: 'REAL_BUG' as const, confidence: 0.7 },
          { class: 'REAL_BUG' as const, confidence: 0.8 },
          { class: 'ENV_ISSUE' as const, confidence: 0.9 },
        ],
      },
      { payload: payload('c'), classification: classification() },
    ];
    const envelope = buildSinkEnvelope(classified, 0.01, null, {}, 'claude-haiku-4-5');
    expect(envelope.schema).toBe('ai-triage-sink/v1');
    expect(envelope.failures[0]!.reused).toBe(true);
    expect(envelope.failures[0]!.draws).toBeUndefined();
    expect(envelope.failures[1]!.reused).toBeUndefined();
    expect(envelope.failures[1]!.draws).toEqual([
      { class: 'REAL_BUG', confidence: 0.7 },
      { class: 'REAL_BUG', confidence: 0.8 },
      { class: 'ENV_ISSUE', confidence: 0.9 },
    ]);
    expect('reused' in envelope.failures[1]!).toBe(false);
    expect('draws' in envelope.failures[0]!).toBe(false);
    expect(envelope.failures[2]!.reused).toBeUndefined();
    expect(envelope.failures[2]!.draws).toBeUndefined();
  });

  it('builds a versioned envelope with fingerprints and class counts', () => {
    const classified = [
      { payload: payload('a'), classification: classification() },
      { payload: payload('b'), classification: classification({ class: 'FLAKY' }) },
    ];
    const envelope = buildSinkEnvelope(
      classified,
      0.0012,
      { current: 1, total: 2 },
      {},
      'claude-haiku-4-5',
    );
    expect(envelope.schema).toBe('ai-triage-sink/v1');
    expect(envelope.reporter).toBe('playwright-ai-triage');
    expect(Date.parse(envelope.createdAt)).not.toBeNaN();
    expect(envelope.run.shard).toEqual({ current: 1, total: 2 });
    expect(envelope.summary).toMatchObject({
      failures: 2,
      costUsd: 0.0012,
      model: 'claude-haiku-4-5',
      counts: { REAL_BUG: 1, FLAKY: 1, SELECTOR_DRIFT: 0, ENV_ISSUE: 0, UNCLASSIFIED: 0 },
    });
    expect(envelope.failures[0]).toEqual({
      fingerprint: failureFingerprint(payload('a')),
      payload: payload('a'),
      classification: classification(),
    });
  });

  it('carries CI metadata from the environment when present', () => {
    const envelope = buildSinkEnvelope(
      [],
      null,
      null,
      {
        GITHUB_REPOSITORY: 'octo/repo',
        GITHUB_SHA: 'abc123',
        GITHUB_HEAD_REF: 'feat/x',
        GITHUB_REF: 'refs/pull/7/merge',
      },
      null,
    );
    expect(envelope.run).toMatchObject({
      shard: null,
      repository: 'octo/repo',
      commit: 'abc123',
      branch: 'feat/x',
      prNumber: 7,
    });
    expect(envelope.summary.costUsd).toBeNull();
    expect(envelope.summary.model).toBeNull();
  });

  it('omits CI fields entirely outside CI', () => {
    const envelope = buildSinkEnvelope([], null, null, {}, null);
    expect(envelope.run).toEqual({ shard: null });
  });
});

describe('postToSink', () => {
  const okFetch = () =>
    vi.fn(async (_url: string, _init?: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

  it('POSTs the envelope as JSON to the sink URL', async () => {
    const fetchImpl = okFetch();
    const envelope = buildSinkEnvelope([], null, null, {}, null);
    const result = await postToSink(envelope, 'https://sink.example/ingest', undefined, fetchImpl);
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://sink.example/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect((init as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual(JSON.parse(JSON.stringify(envelope)));
    expect(init.headers.authorization).toBeUndefined();
  });

  it('sends a bearer token when one is configured', async () => {
    const fetchImpl = okFetch();
    const envelope = buildSinkEnvelope([], null, null, {}, null);
    await postToSink(envelope, 'https://sink.example/ingest', 's3cret', fetchImpl);
    const init = fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe('Bearer s3cret');
  });

  it('reports a non-2xx response as a note, never throws', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const result = await postToSink(
      buildSinkEnvelope([], null, null, {}, null),
      'https://sink.example/ingest',
      undefined,
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.note).toContain('503');
  });

  it('reports a non-Error throw as a note, never throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw 'string boom';
    });
    const result = await postToSink(
      buildSinkEnvelope([], null, null, {}, null),
      'https://sink.example/ingest',
      undefined,
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.note).toContain('string boom');
  });

  it('reports a network failure as a note, never throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await postToSink(
      buildSinkEnvelope([], null, null, {}, null),
      'https://sink.example/ingest',
      undefined,
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.note).toContain('ECONNREFUSED');
  });
});
