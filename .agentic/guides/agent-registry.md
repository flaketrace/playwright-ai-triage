# Agent Registry — playwright-ai-triage

<!-- Scaffolded by agentic-os to .agentic/guides/agent-registry.md.
     THE single routing matrix: intent → exactly one owning asset.
     AGENTS.md links here and never restates this table.
     Installed role presets: developer — the installer removes rows
     whose preset is not installed. -->

Canonical **agent** contracts live in `.agentic/agents/`; their
harness-specific files (`.claude/agents/`, `.claude/commands/<agent>.md`) are thin
pointers. The two **orchestration commands** (`pipeline-orchestrator`, `dispatch`)
are the exception: they are commands, not agents — their canonical body lives
directly in `.claude/commands/`.

## Orchestration matrix (intent → owner)

One owning asset per intent. Never fork the workflow: do not run a parallel
flow for the same task; pick the owner and cite anything else as reference.

| Trigger / intent | Owning asset | Human gate / escalation notes |
| --- | --- | --- |
| Review staged changes before commit | `.agentic/agents/blind-code-reviewer.md` | Mandatory before every commit (pre-commit review gate); blocks on non-empty `## Blocking`. |
| Security posture / secrets / auth surfaces | `.agentic/agents/security-reviewer.md` | Must report `PASS` before merge; findings route per escalation-policy. |
| Grade governance/instruction files | `.agentic/agents/instruction-auditor.md` | Scores below 95 block the graded agent's spawn. |
| Staged multi-agent feature flow | `.claude/commands/pipeline-orchestrator.md` | Judgment gates via decision-router; `escalate_on` flags stop the pipeline. |
| <!-- generated-agent-rows --> | | |

Stack-specific writer/gate agents generated at install time (schema, API,
component, i18n, migration-validator, …) get `owner: generated` rows
directly below the row above (the one whose first cell is the
`<!-- generated-agent-rows -->` marker) — a real, mostly-empty table row, not
a standalone comment line, specifically so appended rows stay part of the
same contiguous GFM table block instead of rendering as orphaned paragraph
text (a bare comment line between table rows breaks table continuity on
GitHub and most Markdown renderers regardless of blank-line spacing). Rows
appended by the installer orchestrator once generation finishes for all
applicable slots in a pass (never by an individual generator subagent — they
run in parallel and would race on this shared file). One row per applicable
writer/gate slot; `stack-guides` never gets one, it isn't dispatchable.
Regenerating a slot replaces its existing row rather than duplicating it. A
fresh install with no `generated` set (a `qa`-only or `pm-delivery`-only
union, or a repo with zero applicable capabilities) leaves the marker row as
the last row in the table — that's a complete, valid state, not a
placeholder waiting to be filled.

## Orchestration rules

- **One owner per intent.** If two rows seem to match, the more specific intent wins; if still ambiguous, ask the dispatcher.
- **Gates are read-only.** Reviewer/auditor/gate agents report; the parent (or a writer agent) owns the fix.
- **Escalation is layered**, not improvised: hard hook denial → `## Blocking` → `## Non-blocking` → `## Escalate to human` — see `.agentic/guides/policy/escalation-policy.md`.
- **Multi-step work** goes through the orchestration style your HITL mode prescribes: `strict` installs default to `dispatch`; `gated-autonomous`/`autonomous` default to `pipeline-orchestrator`.
- Binding process rules live in `.agentic/guides/` (policies under `policy/`, standards under `standards/`) — owned there, referenced everywhere else.
