# Architecture Decision Records

Real design decisions behind the classifier, documented as Context / Decision / Alternatives
considered / Consequences.

- [ADR-001](ADR-001-llm-as-judge-not-rule-based.md) — LLM-as-judge for ambiguous failures, rule-based for decidable ones
- [ADR-002](ADR-002-taxonomy-of-classes.md) — A flat five-class taxonomy, not a deeper one
- [ADR-003](ADR-003-self-consistency-not-self-reported-confidence.md) — Measure reliability via self-consistency, not self-reported confidence
- [ADR-004](ADR-004-handling-imbalanced-classes.md) — Handling imbalanced classes
- [ADR-005](ADR-005-token-cost-vs-accuracy.md) — Token cost vs. accuracy — where the line is drawn

These ADRs were written after the fact, documenting decisions already implemented in
`src/prompt.ts`, `src/heuristics.ts`, `src/classify.ts`, `src/reliability.ts`, and
`src/metrics.ts` — not proposals. Each cites the specific code, prompt rule, or `CHANGELOG.md`
entry the decision traces back to.

**Numbering note:** this `ADR-NNN` sequence is independent of the `ADR-0003`/`ADR-0012`
citations scattered across several source comments (e.g. `src/classify.ts`, `src/config.ts`).
Those refer to the maintainer's private design notes, which `CONTRIBUTING.md` explains are not
in this repository. The two numbering schemes are unrelated; don't try to cross-reference them.
