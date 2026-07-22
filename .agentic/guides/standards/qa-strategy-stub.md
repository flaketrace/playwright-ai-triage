# QA Strategy — stub

This project's QA knowledge foundation has not been built yet.

Run the `agentic-sdlc:qa-foundation` skill (`/sdlc:qa-init`) to generate it: it
discovers test files, coverage reports, and CI gates in this repo, asks about
external test repos and test-case management, and replaces this stub with a real
`qa-strategy.md` (plus `qa-health.md`) under `.agentic/guides/testing/`.

Until then:
- Test commands and their pass/fail shapes live in
  [`quality-gates.md`](quality-gates.md).
- Flaky-test handling follows
  [`flaky-protocol.md`](flaky-protocol.md) (classify → ledger → root-cause fix →
  burn-in); never delete or retry-loop a flaky test to green.
- New pure logic ships with unit tests
  ([`code-quality.md`](code-quality.md) §Tests & gates).
