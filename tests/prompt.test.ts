import { describe, expect, it } from 'vitest';

import { PROMPT_VERSION, SYSTEM_PROMPT } from '../src/prompt.js';

describe('SYSTEM_PROMPT self-consistency', () => {
  it('PROMPT_VERSION matches the vNNN format', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });

  it('the Examples header count matches the number of [real, sanitized] entries', () => {
    const headerMatch = SYSTEM_PROMPT.match(/## Examples \((\d+) real, sanitized/);
    expect(headerMatch).not.toBeNull();
    const declaredCount = Number(headerMatch![1]);
    const actualCount = (SYSTEM_PROMPT.match(/\[real, sanitized\]/g) ?? []).length;
    expect(actualCount).toBe(declaredCount);
  });
});
