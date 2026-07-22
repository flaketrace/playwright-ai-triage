# AI Autonomy Policy — playwright-ai-triage

<!-- Scaffolded by agentic-os to .agentic/guides/policy/ai-policy.md (human-owned after install).
     Single source of truth for what AI agents may do autonomously in this repository.
     Agent contracts and skills reference this file by path; they must not restate it. -->

This file is the **policy of record** for AI-agent autonomy in this repository.
It applies to every AI agent operating against this repo — interactive sessions,
subagents, pipelines, and any future tool. When the policy changes, update this
file only; contracts that reference it inherit the change.

Stack context: playwright-ai-triage is a small TypeScript-strict, ESM-first npm library: a Playwright test reporter that classifies test failures with an LLM (Anthropic SDK + zod are the only runtime dependencies, @playwright/test is a peer dependency). Source is src/index.ts + src/types.ts; unit tests run under vitest; the build is tsup (dual CJS/ESM + d.ts); lint is eslint + prettier; releases go through changesets. Node >=18 engines, npm as package manager, CI on GitHub Actions (.github/workflows/ci.yml runs lint, typecheck, test, build — the same steps as the npm run gate script). There is no database, no server, no UI surface, and no i18n: it is a pure library with nothing to start and no base URL.

## HITL mode

Active mode: **`gated-autonomous`** (set at install; change it here, consciously).

| Mode | Meaning |
| --- | --- |
| `strict` | Every step is user-gated. Agents recommend; humans execute anything in the "gated" column below. |
| `gated-autonomous` | Pipelines run on their own; judgment gates, the escalation ladder, and `escalate_on` flags stop them. |
| `autonomous` | agentic-sdlc autonomous mode with stand-in resolvers; the escalation rule in `escalation-policy.md` still forces human decisions. |

## Autonomy matrix

What agents may do without a per-action human approval, by capability and mode.
**allowed** = do it; **gated** = propose the exact action and wait for explicit
approval; **never** = do not do it in this mode at all.

| Capability | `strict` | `gated-autonomous` | `autonomous` |
| --- | --- | --- | --- |
| Read repo files (except secret patterns — see `safety-policy.md`) | allowed | allowed | allowed |
| Edit files inside the agent's declared `write_scope` | allowed | allowed | allowed |
| Run local quality gates (see *Quality gates* below) | allowed | allowed | allowed |
| Execute the test suite | never (recommend the exact command; a human or CI runs it) | allowed | allowed |
| `git commit` (review-gated — see below) | gated | allowed | allowed |
| `git push` to a topic branch | gated | allowed | allowed |
| Push to `main` / production deploy | never | never | never |
| Create/update tickets or work items via none | gated (echo the full payload, then wait) | gated | gated |
| Open/update MRs via gh | gated | allowed | allowed |
| Drive a browser against unauthenticated pages | allowed | allowed | allowed |
| Drive a browser against an authenticated session, or mutate data through it | gated (per action) | gated (per action) | gated (per action) |

Human-gated **commands** (always blocked pending human action, regardless of mode)
are listed in `escalation-policy.md` — one list, not two.

### Per-repository overrides

Set at install (interview Screen 3) for this repo, these **tighten** the active
mode's row above for a specific capability — never loosen it. An agent reads the
override where one exists and the matrix row otherwise.

_No per-repository overrides — every capability follows the active mode's row above._

## Size ceiling

Lightweight AI-assisted changes stay **≤ 250 lines of code and ≤ 10 files**
per change. Compute from the diff (`git diff --shortstat`); ignore lockfile and
generated-asset line churn for LOC, but always count files.

Breach ⇒ **escalate**: the change does not proceed until a human explicitly
approves the larger scope or the change is split. Reviewers list a breach under
`## Blocking` with the measured numbers.

## Environment write boundaries

| Environment | Allowed operations | Notes |
| --- | --- | --- |
| Local / ephemeral | Full CRUD | Test setup/teardown data is expected here. |
| **none** | Full CRUD for test data with idempotent cleanup | Create what you assert on; tear it down; never depend on data another suite left behind. |
| Production | **Read-only** | No writes, no test execution, no schema changes, no secret rotation — by agents or by code they author for automated paths. |

Test-CRUD clarification: writing setup/teardown code that creates, updates, and
deletes test data on none is explicitly permitted and expected —
that is what test automation is for. The read-only boundary targets production.

## Always forbidden (all modes)

- Removing or disabling existing logs, metrics, or health indicators — or writing code that does.
- Deleting or disabling tests, or introducing skipped/focused-test markers, except a runtime-conditional guard with an inline lint-suppression and a one-line reason.
- Reading or rotating secrets and credentials (deny patterns in `safety-policy.md`).
- Running under a privileged identity. Agents draft what a privileged human then runs through normal review.

## Enforcement layers

Soft layers tell the model what not to do; hard layers fail closed and do not
depend on the model cooperating.

| Layer | Mechanism | Style |
| --- | --- | --- |
| This policy + agent contracts | referenced from every contract | soft |
| Secret read denial | settings deny rules (patterns pinned in `safety-policy.md`) | hard |
| Pre-commit review stamp | `.claude/hooks/precommit_review_gate.py` + `.githooks/pre-commit` (git hook maintainer-local) | hard (exit 2) |
| Output-contract gate | `.claude/hooks/subagent_gate.py` (fail-closed) | hard (exit 2) |
| Write-scope guard | `.claude/hooks/write_scope_guard.py` per agent contract | hard (exit 2) |
| Instruction-quality gate | `.claude/hooks/instruction_gate.py` vs docs/audits/instruction-scorecard.json | hard (exit 2) |

## Quality gates

The local gate commands for this repository (run before staging any change):

```
npm run gate
```

## Confidentiality boundary

This package is deliberately developed by dogfooding it against **non-public
projects**. The learning is welcome; the data is not. Nothing derived from a
non-public project may appear in any published surface — code, comments, tests,
fixtures, commit messages, PR titles/bodies/comments, issues, or releases. That
includes: build/pipeline identifiers, product and platform names, hostnames and
endpoint paths, work-item/test-case IDs, department/account/tenant names, and
application UI strings captured from snapshots or logs.

Sanitize at the boundary, before anything leaves the machine: synthesize fixtures
against neutral localhost servers, paraphrase quoted errors to generic form, and name
things after neutral domains (cart/catalog/orders), never after the source system.

**Reviewers**: any identifier in a staged diff, commit message, or planned publication
text that plausibly originates from a non-public project is a **Blocking** finding —
severity is not reduced by the identifier looking "minor" — a bare build number is
enough to identify a source system. Do not quote the suspect identifier in any
published review output; point to file and line only.

Mechanical backstop: `.claude/hooks/leak_gate.py` scans publish commands against a
machine-global confidential pattern list (`~/.claude/leak_patterns.txt`) merged with
an optional repo-local overlay (`.claude/hooks/leak_patterns.txt`, gitignored). On
machines carrying the `~/.claude/.leak_gate_required` marker, a missing list blocks
publishing outright. The gate is a net, not a licence — the boundary is this policy,
and unlisted identifiers are still violations.

## Related policy

- `.agentic/guides/policy/escalation-policy.md` — escalation ladder, `escalate_on` flags, human-gated commands.
- `.agentic/guides/policy/safety-policy.md` — secrets, MCP/browser safety, git/remote actions.
