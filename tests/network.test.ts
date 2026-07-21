import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TestResult } from '@playwright/test/reporter';
import { describe, expect, it } from 'vitest';

import { failedRequestsFrom, sanitizeUrl } from '../src/network.js';

/**
 * The three fixtures under `tests/fixtures/` are trace.zip files WRITTEN BY
 * PLAYWRIGHT 1.61.1 — real chromium runs against a throwaway localhost server,
 * kept byte-for-byte. Nothing here is hand-built, because everything genuinely
 * risky about reading a trace is Playwright's own zip output: entry naming and
 * ordering, deflate vs stored, data descriptors, the `resources/`, `test.trace`
 * and `*.stacks` siblings that must be skipped. A zip we authored ourselves would
 * only prove the reader agrees with our idea of a zip.
 *
 * Each capture navigated a page that fetched a fixed set of endpoints, then failed
 * on a locator that never appears:
 *
 *   trace-with-failed-requests.zip  two browser contexts, so Playwright wrote two
 *                                   `.network` segments: 200 /api/ok and
 *                                   503 /api/cart?token=… in the first,
 *                                   the same 503 plus 429 /api/catalog in the
 *                                   second — a real cross-segment duplicate
 *   trace-all-ok.zip                200 /api/ok only
 *   trace-many-failures.zip         500 on twelve distinct /many/endpoint-N
 *
 * One caveat learned the hard way while capturing these: a trace recorded with
 * `snapshots: false` writes a ZERO-BYTE `.network` segment. Network evidence rides
 * on snapshot tracing, which is on by default but can be configured away.
 */
const TRACE = path.join(import.meta.dirname, 'fixtures/trace-with-failed-requests.zip');
const ORIGIN = 'http://127.0.0.1:8129';

function resultWithTrace(tracePath: string | undefined): TestResult {
  return {
    retry: 0,
    status: 'failed',
    duration: 1,
    errors: [],
    steps: [],
    attachments: tracePath
      ? [{ name: 'trace', contentType: 'application/zip', path: tracePath }]
      : [],
  } as unknown as TestResult;
}

describe('sanitizeUrl', () => {
  it('drops the query string and the fragment', () => {
    expect(sanitizeUrl('https://api.example.com/v1/cart?token=shhh#frag')).toBe(
      'https://api.example.com/v1/cart',
    );
  });

  it('drops URL userinfo — credentials before the host are never evidence', () => {
    expect(sanitizeUrl('https://alice:hunter2@api.example.com/v1/cart')).toBe(
      'https://api.example.com/v1/cart',
    );
  });

  it('keeps the path, which is what names the failing endpoint', () => {
    expect(sanitizeUrl('https://api.example.com/orders/2026/line-items/17')).toBe(
      'https://api.example.com/orders/2026/line-items/17',
    );
  });

  it('leaves a URL it cannot parse alone rather than guessing', () => {
    expect(sanitizeUrl('not a url at all')).toBe('not a url at all');
  });
});

describe('failedRequestsFrom', () => {
  it('extracts 4xx/5xx responses from the trace and ignores successful ones', () => {
    const requests = failedRequestsFrom(resultWithTrace(TRACE));
    expect(requests).toEqual([
      { status: 503, method: 'GET', url: `${ORIGIN}/api/cart` },
      { status: 429, method: 'GET', url: `${ORIGIN}/api/catalog` },
    ]);
  });

  it('drops the query string — an endpoint identity is the evidence, a session token is not', () => {
    const requests = failedRequestsFrom(resultWithTrace(TRACE)) ?? [];
    expect(requests.every((r) => !r.url.includes('?'))).toBe(true);
    expect(requests.every((r) => !r.url.includes('token'))).toBe(true);
  });

  it('deduplicates one endpoint that failed more than once', () => {
    const requests = failedRequestsFrom(resultWithTrace(TRACE)) ?? [];
    expect(requests.filter((r) => r.url.endsWith('/cart'))).toHaveLength(1);
  });

  it('returns undefined when the run captured no trace', () => {
    expect(failedRequestsFrom(resultWithTrace(undefined))).toBeUndefined();
  });

  it('returns undefined for a missing trace file rather than throwing', () => {
    expect(failedRequestsFrom(resultWithTrace('/nope/absent-trace.zip'))).toBeUndefined();
  });

  it('returns undefined for a file that is not a zip rather than throwing', () => {
    const notAZip = path.join(import.meta.dirname, 'network.test.ts');
    expect(failedRequestsFrom(resultWithTrace(notAZip))).toBeUndefined();
  });

  it('returns undefined when a trace holds only successful requests', () => {
    const onlyOk = path.join(import.meta.dirname, 'fixtures/trace-all-ok.zip');
    expect(failedRequestsFrom(resultWithTrace(onlyOk))).toBeUndefined();
  });

  /**
   * Rewrite the central-directory `compressed size` (header + 20) of the FIRST
   * `.network` entry, then hand the result back as a temp file. Two hazards live
   * behind this field: it sizes a `Buffer.alloc` — 0xffffffff means a 4 GiB
   * allocation inside Playwright's own process — and 0xffffffff is also the zip64
   * "look elsewhere" sentinel, so a zip64 entry lands here by a second route.
   * A trace whose tail a killed CI job truncated is the realistic way to get one.
   */
  function withCorruptedFirstSegment(sizeField: number): string {
    const buffer = fs.readFileSync(TRACE);
    let eocd = buffer.length - 22;
    while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    let cursor = buffer.readUInt32LE(eocd + 16);
    for (;;) {
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      if (name.endsWith('.network')) {
        buffer.writeUInt32LE(sizeField, cursor + 20);
        break;
      }
      cursor +=
        46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    }
    const corrupted = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ai-triage-trace-')),
      'trace.zip',
    );
    fs.writeFileSync(corrupted, buffer);
    return corrupted;
  }

  it('skips a segment whose declared size overruns the file, keeping the other segment', () => {
    const requests = failedRequestsFrom(resultWithTrace(withCorruptedFirstSegment(0xfffffff0)));
    // the surviving segment is the second context's: same 503, plus its own 429
    expect(requests).toEqual([
      { status: 503, method: 'GET', url: `${ORIGIN}/api/cart` },
      { status: 429, method: 'GET', url: `${ORIGIN}/api/catalog` },
    ]);
  });

  it('skips a zip64 segment rather than reading at a sentinel offset', () => {
    const requests = failedRequestsFrom(resultWithTrace(withCorruptedFirstSegment(0xffffffff)));
    expect(requests).toHaveLength(2);
  });
});
