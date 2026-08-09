import { describe, expect, it, vi } from 'vitest';

import { dispatch } from '../src/cli.js';

vi.mock('../src/cli/eval.js', () => ({ runEval: vi.fn(async () => 0) }));
vi.mock('../src/cli/label.js', () => ({ runLabel: vi.fn(async () => 0) }));

describe('dispatch', () => {
  it('routes "eval" to runEval', async () => {
    const { runEval } = await import('../src/cli/eval.js');
    const code = await dispatch(['eval', '--draws=5']);
    expect(code).toBe(0);
    expect(runEval).toHaveBeenCalledWith(['--draws=5']);
  });

  it('routes "label" to runLabel', async () => {
    const { runLabel } = await import('../src/cli/label.js');
    const code = await dispatch(['label', '--run', 'x.json']);
    expect(code).toBe(0);
    expect(runLabel).toHaveBeenCalledWith(['--run', 'x.json']);
  });

  it('returns 2 and prints usage for an unknown command', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const code = await dispatch(['bogus']);
      expect(code).toBe(2);
      expect(errors.join(' ')).toMatch(/Usage/);
    } finally {
      console.error = original;
    }
  });
});
