# Escalation Policy — playwright-ai-triage

<!-- Scaffolded by agentic-os to .agentic/guides/policy/escalation-policy.md (human-owned after install).
     Single source of truth for WHEN work stops and a human decides.
     Referenced by every agent contract; never restated in them. -->

## Risk flags that force escalation

`escalate_on`: **security,breaking-change,migration,spend**

Any change or decision carrying one of these flags goes to a human — no
autonomous resolution, no stand-in verdict, regardless of HITL mode
(`.agentic/guides/policy/ai-policy.md`).

## Human-gated commands

These shell operations are always blocked pending explicit human action, in
every mode:

```
git push origin main
```

Guarded write paths (writable only through their named flow):

```

```

## The four-layer escalation ladder

Every stop signal in this repo belongs to exactly one layer. Lower layers are
mechanical; higher layers are judgment.

| Layer | Signal | Who acts | Semantics |
| --- | --- | --- | --- |
| 1. Hard hook denial | hook exit code 2 + stderr | nobody proceeds | The action is blocked mechanically (unreviewed commit, out-of-scope write, human-gated command). Fix the cause; never work around the hook. |
| 2. `## Blocking` | non-empty section in an agent's output contract | the parent agent | Stop and fix. No silent auto-retry: resolve the listed items (or change the input) before re-delegating. The subagent-gate hook enforces this with exit 2. |
| 3. `## Non-blocking` | non-empty section | the parent agent | Advisory. Proceed, but carry the items forward into the hand-off so they are not lost. |
| 4. `## Escalate to human` | non-empty section | **the human** | An explicit decision question with options. The parent agent must present it via AskUserQuestion (or equivalent) and wait — it must not pick an option itself. |

The output contract itself (five sections: Summary / Why / Blocking /
Non-blocking / Escalate to human) is defined in each agent contract and parsed
**fail-closed** by `.claude/hooks/subagent_gate.py`: a missing contract is
treated as Blocking.

## How agentic-sdlc's decision-router consumes these flags

At every judgment gate the decision-router resolves a verdict:

- **HITL mode** (`strict` / `gated-autonomous` for the gate in question): it
  short-circuits to the human — AskUserQuestion, no autonomous stand-in.
- **Autonomous mode**: deterministic checks → fast-path approval → stand-in
  subagent, in that order — **unless** the gate's `risk_flags` intersect
  `escalate_on` above, confidence is low, or the agent output is malformed;
  any of those routes the gate to the human.
- The scaffolded `.agentic/agentic-sdlc/config.json` wires `escalate_on` from
  this file. Keep the two in sync when editing the flag list (this file is the
  source; the config is the machine copy).
- Every verdict is audited to `decisions.jsonl` + `events.jsonl` in the run
  directory with the prior context that produced it.

## What a good escalation looks like

An `## Escalate to human` entry is a decision, not a status report:

```
- <one-line question> Options: (a) <option + consequence>, (b) <option + consequence>[, (c) ...]
```

Bad: "there were problems with the migration." Good: "Migration renames a
column used by two consumers. Options: (a) expand-contract in two releases,
(b) single breaking migration with coordinated deploy."
