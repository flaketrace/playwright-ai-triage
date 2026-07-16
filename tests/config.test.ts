import { describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../src/config.js';

describe('resolveConfig', () => {
  it('applies defaults with no options and no env', () => {
    const c = resolveConfig({}, {});
    expect(c).toMatchObject({
      model: 'claude-haiku-4-5',
      outputs: ['stdout'],
      includeDom: false,
      maxFailures: 25,
      dryRun: false,
      failSilently: true,
    });
    expect(c.apiKey).toBeUndefined();
  });

  it('auto-detects outputs from environment', () => {
    expect(resolveConfig({}, { GITHUB_ACTIONS: 'true' }).outputs).toEqual(['stdout', 'github']);
    expect(resolveConfig({}, { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' }).outputs).toEqual([
      'stdout',
      'slack',
    ]);
    expect(
      resolveConfig({}, { GITHUB_ACTIONS: 'true', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' })
        .outputs,
    ).toEqual(['stdout', 'github', 'slack']);
  });

  it('explicit outputs override auto-detection and are de-duplicated', () => {
    const c = resolveConfig({ outputs: ['stdout', 'stdout'] }, { GITHUB_ACTIONS: 'true' });
    expect(c.outputs).toEqual(['stdout']);
  });

  it('invalid options warn and fall back to defaults — never throws', () => {
    const warn = vi.fn();
    const c = resolveConfig({ maxFailures: -3, model: 42 as unknown as string }, {}, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(c.maxFailures).toBe(25);
    expect(c.model).toBe('claude-haiku-4-5');
  });

  it('typo’d option keys warn instead of silently vanishing — valid options survive', () => {
    const warn = vi.fn();
    const c = resolveConfig({ maxFailure: 5, includeDom: true } as never, {}, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('maxFailure');
    expect(c.maxFailures).toBe(25); // the typo'd key never applied
    expect(c.includeDom).toBe(true); // the valid sibling option is NOT nuked
  });

  it('ignores Playwright-injected reporter internals without warning (regression: real run)', () => {
    const warn = vi.fn();
    const c = resolveConfig(
      { dryRun: true, configDir: '/repo', _mode: 'test', _commandHash: 'abc' } as never,
      {},
      warn,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(c.dryRun).toBe(true);
  });

  it('empty outputs array warns and falls back (stdout is never lost silently)', () => {
    const warn = vi.fn();
    const c = resolveConfig({ outputs: [] as never }, {}, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(c.outputs).toEqual(['stdout']);
  });

  it('resolves env passthroughs', () => {
    const c = resolveConfig(
      {},
      {
        ANTHROPIC_API_KEY: 'sk-ant-x',
        GITHUB_TOKEN: 'ghtok',
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x',
        GIT_DIFF_SUMMARY: '3 files changed',
      },
    );
    expect(c.apiKey).toBe('sk-ant-x');
    expect(c.githubToken).toBe('ghtok');
    expect(c.slackWebhookUrl).toBe('https://hooks.slack.com/x');
    expect(c.diffSummary).toBe('3 files changed');
  });

  it('accepts a sinkUrl option without an unknown-option warning', () => {
    const warn = vi.fn();
    const c = resolveConfig({ sinkUrl: 'https://sink.example/ingest' }, {}, warn);
    expect(warn).not.toHaveBeenCalled();
    expect(c.sinkUrl).toBe('https://sink.example/ingest');
  });

  it('falls back to AI_TRIAGE_SINK_URL when the option is unset — option wins when both exist', () => {
    const fromEnv = resolveConfig({}, { AI_TRIAGE_SINK_URL: 'https://env.example/e' });
    expect(fromEnv.sinkUrl).toBe('https://env.example/e');
    const both = resolveConfig(
      { sinkUrl: 'https://opt.example/o' },
      { AI_TRIAGE_SINK_URL: 'https://env.example/e' },
    );
    expect(both.sinkUrl).toBe('https://opt.example/o');
    expect(resolveConfig({}, {}).sinkUrl).toBeUndefined();
  });

  it('reads the sink token from env only', () => {
    const c = resolveConfig({}, { AI_TRIAGE_SINK_TOKEN: 'tok' });
    expect(c.sinkToken).toBe('tok');
    expect(resolveConfig({}, {}).sinkToken).toBeUndefined();
  });

  it('an invalid sinkUrl disables the sink with a warning — other options survive', () => {
    const warn = vi.fn();
    const c = resolveConfig({ sinkUrl: 'not a url', dryRun: true, maxFailures: 7 }, {}, warn);
    expect(c.sinkUrl).toBeUndefined();
    expect(c.dryRun).toBe(true);
    expect(c.maxFailures).toBe(7);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sink'));
  });

  it('an invalid option sinkUrl does not silently fall back to the env URL', () => {
    const warn = vi.fn();
    const c = resolveConfig(
      { sinkUrl: 'not a url' },
      { AI_TRIAGE_SINK_URL: 'https://env.example/e' },
      warn,
    );
    expect(c.sinkUrl).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('an invalid env sink URL also warns and disables the sink', () => {
    const warn = vi.fn();
    const c = resolveConfig({}, { AI_TRIAGE_SINK_URL: 'nope' }, warn);
    expect(c.sinkUrl).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sink'));
  });

  it('rejects non-http(s) sink protocols', () => {
    const warn = vi.fn();
    const c = resolveConfig({ sinkUrl: 'ftp://sink.example/x' }, {}, warn);
    expect(c.sinkUrl).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('warns when a bearer token would travel over plaintext http', () => {
    const warn = vi.fn();
    const c = resolveConfig(
      { sinkUrl: 'http://sink.example/x' },
      { AI_TRIAGE_SINK_TOKEN: 'tok' },
      warn,
    );
    expect(c.sinkUrl).toBe('http://sink.example/x');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plaintext'));
  });
});
