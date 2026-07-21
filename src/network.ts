import fs from 'node:fs';
import zlib from 'node:zlib';

import type { TestResult } from '@playwright/test/reporter';

import type { FailedRequest } from './types.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
/** EOCD is 22 bytes plus a comment of at most 65535 */
const EOCD_SEARCH_WINDOW = 22 + 0xffff;
/** a zip field pinned to all-ones means "see the zip64 record" — traces never reach it */
const ZIP64_SENTINEL = 0xffffffff;
/** stop after this much decoded .network data; the segment in flight may exceed it */
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;
/** a single segment may not decode past this — a compressed size is attacker-shaped */
const MAX_SEGMENT_BYTES = 2 * 1024 * 1024;

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function read(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

/**
 * Minimal zip central-directory reader.
 *
 * A Playwright trace is a ~20MB zip of ~900 entries whose `*.network` segments are
 * a few KB each, so reading the whole archive to reach them would be absurd. Walking
 * the central directory lets us seek straight to the segments we want. Deliberately
 * partial: no zip64, no encryption, no multi-disk — a trace that needs any of those
 * simply yields no network evidence rather than a thrown reporter.
 */
function centralDirectoryEntries(fd: number, fileSize: number): ZipEntry[] {
  const tailLength = Math.min(fileSize, EOCD_SEARCH_WINDOW);
  const tail = read(fd, tailLength, fileSize - tailLength);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return [];

  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  if (centralOffset === ZIP64_SENTINEL || centralSize === ZIP64_SENTINEL) return [];
  if (centralOffset + centralSize > fileSize) return [];

  const central = read(fd, centralSize, centralOffset);
  const entries: ZipEntry[] = [];
  let cursor = 0;
  while (cursor + 46 <= central.length) {
    if (central.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) break;
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    entries.push({
      name: central.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      compressionMethod: central.readUInt16LE(cursor + 10),
      compressedSize: central.readUInt32LE(cursor + 20),
      localHeaderOffset: central.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(fd: number, entry: ZipEntry, fileSize: number): string | undefined {
  // Every number below came out of the archive, so none of them may size an
  // allocation unchecked: 0xffffffff in `compressedSize` would ask for 4 GiB inside
  // Playwright's own process, and it doubles as the zip64 "look elsewhere" sentinel.
  // A trace truncated by a killed CI job is enough to produce one.
  if (entry.compressedSize === ZIP64_SENTINEL || entry.localHeaderOffset === ZIP64_SENTINEL) {
    return undefined;
  }
  if (entry.localHeaderOffset + entry.compressedSize > fileSize) return undefined;

  // the central directory's name/extra lengths need not match the local header's
  const localHeader = read(fd, 30, entry.localHeaderOffset);
  if (localHeader.length < 30) return undefined;
  const dataOffset =
    entry.localHeaderOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
  if (dataOffset + entry.compressedSize > fileSize) return undefined;

  const raw = read(fd, entry.compressedSize, dataOffset);
  if (entry.compressionMethod === 0) return raw.subarray(0, MAX_SEGMENT_BYTES).toString('utf8');
  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(raw, { maxOutputLength: MAX_SEGMENT_BYTES }).toString('utf8');
  }
  return undefined;
}

/**
 * Reduce a URL to the part that is evidence: origin + path.
 *
 * A query string routinely carries session tokens and ids, and `user:pass@` before
 * the host is a credential outright — neither tells the classifier anything the
 * endpoint name does not. The path stays: "which endpoint returned 503" is the
 * whole point, and collapsing it further would make two distinct failing endpoints
 * indistinguishable. Path segments can still hold identifiers, so the result also
 * goes through the reporter's `redact` patterns before it leaves.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // not a parseable URL — a bare truncation beats guessing at its structure
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

function parseSegment(ndjson: string, into: Map<string, FailedRequest>): void {
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // a truncated final line is normal in a trace killed mid-run
    }
    const record = event as { type?: string; snapshot?: Record<string, unknown> } | null;
    const snapshot = record?.snapshot;
    if (record?.type !== 'resource-snapshot' || !snapshot) continue;
    const request = snapshot.request as { method?: string; url?: string } | undefined;
    const status = (snapshot.response as { status?: number } | undefined)?.status;
    if (typeof status !== 'number' || status < 400) continue;
    if (!request?.url || !request.method) continue;
    const failed: FailedRequest = {
      status,
      method: request.method,
      url: sanitizeUrl(request.url),
    };
    // one endpoint failing 40 times is one fact; keep the first occurrence
    const key = `${failed.status} ${failed.method} ${failed.url}`;
    if (!into.has(key)) into.set(key, failed);
  }
}

/**
 * Failed HTTP responses recorded in this attempt's trace, or undefined when there
 * are none (or no readable trace).
 *
 * Playwright's error text never names the status behind a UI-side failure: a
 * backend 503 surfaces only as "timeout waiting for the predicate", which reads
 * like a flake. The status lives in the trace, so that is where we go and get it.
 * Best-effort by construction — tracing is opt-in, and a trace we cannot parse
 * must cost the run nothing.
 */
export function failedRequestsFrom(result: TestResult): FailedRequest[] | undefined {
  const trace = result.attachments.find((a) => a.name === 'trace' && a.path);
  if (!trace?.path) return undefined;

  let fd: number | undefined;
  try {
    fd = fs.openSync(trace.path, 'r');
    const fileSize = fs.fstatSync(fd).size;
    const found = new Map<string, FailedRequest>();
    let inflated = 0;
    for (const entry of centralDirectoryEntries(fd, fileSize)) {
      if (!entry.name.endsWith('.network')) continue;
      if (inflated >= MAX_INFLATED_BYTES) break;
      // A real trace holds one segment per browser context, so one unreadable
      // segment must not discard the evidence the others already yielded.
      try {
        const ndjson = readEntry(fd, entry, fileSize);
        if (!ndjson) continue;
        inflated += Buffer.byteLength(ndjson);
        parseSegment(ndjson, found);
      } catch {
        continue;
      }
    }
    return found.size > 0 ? [...found.values()] : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      // a close that fails has nothing left to protect, and must not lose the run
    }
  }
}
