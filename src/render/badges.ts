export const CLASS_ORDER = [
  'REAL_BUG',
  'SELECTOR_DRIFT',
  'FLAKY',
  'ENV_ISSUE',
  'UNCLASSIFIED',
] as const;

export const CLASS_BADGE: Record<(typeof CLASS_ORDER)[number], string> = {
  REAL_BUG: '🐞 REAL_BUG',
  SELECTOR_DRIFT: '🎯 SELECTOR_DRIFT',
  FLAKY: '🎲 FLAKY',
  ENV_ISSUE: '🌩 ENV_ISSUE',
  UNCLASSIFIED: '❔ UNCLASSIFIED',
};
