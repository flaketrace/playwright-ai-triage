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
});
