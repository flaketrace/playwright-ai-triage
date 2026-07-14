import { describe, expect, it } from 'vitest';

import { redact } from '../src/redact.js';

const MASK = '[REDACTED]';

describe('redact', () => {
  it.each([
    ['anthropic key', 'auth sk-ant-api03-abcdefgh12345678 failed', 'sk-ant-api03-abcdefgh12345678'],
    [
      'github classic token',
      'push with ghp_abcdefghijklmnopqrst123456 denied',
      'ghp_abcdefghijklmnopqrst123456',
    ],
    [
      'github fine-grained',
      'pat github_pat_11ABCDEFG0abcdefghijklmn rejected',
      'github_pat_11ABCDEFG0abcdefghijklmn',
    ],
    ['slack token', 'xoxb-123456789012-abcdefghijkl leaked', 'xoxb-123456789012-abcdefghijkl'],
    ['aws access key', 'creds AKIAIOSFODNN7EXAMPLE invalid', 'AKIAIOSFODNN7EXAMPLE'],
  ])('masks %s', (_name, text, secret) => {
    const out = redact(text, {});
    expect(out).not.toContain(secret);
    expect(out).toContain(MASK);
  });

  it('masks bearer tokens but keeps the scheme word', () => {
    const out = redact('header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', {});
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('masks values of secret-named env vars appearing in text', () => {
    const env = {
      MY_API_KEY: 'supersecretvalue',
      DB_PASSWORD: 'hunter2hunter2',
      PLAIN: 'visible-value',
    };
    const out = redact('key=supersecretvalue pw=hunter2hunter2 plain=visible-value', env);
    expect(out).not.toContain('supersecretvalue');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toContain('visible-value');
  });

  it('does not mask short env values (< 8 chars) even when secret-named', () => {
    const out = redact('the word test appears here', { SHORT_TOKEN: 'test' });
    expect(out).toBe('the word test appears here');
  });

  it('does not mask ordinary words containing "sk-"', () => {
    const text = 'shopping for desk-organizers and kiosk-materials today';
    expect(redact(text, {})).toBe(text);
  });

  it('leaves clean text byte-identical', () => {
    const text = 'expect(received).toBe(expected) — 3 !== 4 at spec.ts:12';
    expect(redact(text, {})).toBe(text);
  });
});
