// infraReason now lives in src/reliability.ts — it moved there because it is
// a shipped-package concern (src/reliability.ts's classifyWithSelfConsistency
// needs it to exclude infra-caused draws from the confusion matrix), not just
// dev-only eval tooling. Re-exported here so this dev-only smoke eval and its
// pinned tests (tests/eval-smoke.test.ts) keep working unchanged.
export { infraReason } from '../src/reliability.js';
