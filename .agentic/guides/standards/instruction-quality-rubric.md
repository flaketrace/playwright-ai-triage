# Instruction Quality Rubric — Evidence Accuracy Grading

Read by the `instruction-auditor` agent before grading any governed file (agent
contracts in `.agentic/agents/`, pointer files, guides, index files, hook scripts).
This rubric governs the **evidence_score** half of a file's composite score; the
**structural_score** half is deterministic completeness checking (required sections,
frontmatter fields, non-empty write scope) defined in the instruction-auditor's
contract. Composite scores and thresholds are recorded in
`docs/audits/instruction-scorecard.json`; the SubagentStart gate
(`.claude/hooks/instruction_gate.py`) blocks spawns below threshold.

You verify CLAIMS. You do not grade prose quality, style, or tone.

## What counts as a claim

A claim is any sentence or table cell in the governed file that asserts something
checkable against the current repo state:
- A file path exists ("writes to `app/actions/**`")
- A function/symbol name exists and is used as described ("calls `requireAuth()`")
- A hook's exit code / stdin shape / behavior ("exit 2 to block", "reads `git diff --cached`")
- A cross-reference is accurate ("see `.agentic/guides/standards/git-workflow.md` §Merge strategy")
- A count or table fact ("14 agents", "0 errors / 37 warnings")
- A behavioral claim about another file ("the orchestrator parses PASS from Summary")

NOT a claim — skip, do not force a verification:
- Subjective prose ("this agent is intentionally conservative")
- Forward-looking intent ("will eventually support X")
- Process/etiquette guidance with no code referent ("sync before work")

## Verification method per claim type

| Claim type | How to verify |
|---|---|
| File/path exists | `Glob` or `Read` the path; UNVERIFIED if not found |
| Function/symbol name | `Grep` the symbol in the referenced file or repo; UNVERIFIED if zero matches |
| Exit code / stdin-stdout contract | `Read` the actual script, locate the real exit call / argument parsing; compare to the claim |
| Cross-reference (file A says "see file B §X") | `Read` file B; confirm §X (or the referenced content) exists |
| Count/table fact | Recompute via `Glob`/`Grep` (e.g. count `.md` files in a dir); compare to the stated number |
| Behavioral claim about a peer file | `Read` the peer file; confirm the described behavior is actually implemented |

## Scoring

`score = round(100 * M / N)`, where N = total claims extracted, M = claims verified TRUE.

- N = 0 (no checkable claims — a pure narrative doc or process-only rule) → score = 100.
  Nothing to be wrong about; do not penalize prose-only files.
- A claim contradicted by current code counts as unverified, not skipped.
- A claim whose referent was deleted counts as unverified (method: `"referent not found"`)
  and grading continues — never abort a run on a broken reference.
- No partial credit for "renamed but same purpose." A claim either verifies or it
  doesn't; the fix is updating the doc, not rounding generously.

## Output — evidence trail required

One row per claim, in the agent's `## Claims` output section:

```
[VERIFIED|UNVERIFIED] "<claim text, <=100 chars>" — <verification method + result>
```

Row count must equal N. This list is what gets persisted into
`docs/audits/instruction-scorecard.json`'s `claims` array for that file.

## Special cases

### Hook scripts (`.claude/hooks/*.py`)
Claims are the docstring/header comments (stdin shape, exit codes, "always exit 0",
"blocks with exit 2"). Verify against the actual function bodies below the docstring —
never against other docs. A docstring that says "exit 2 to block" when the code calls
`sys.exit(1)` is an UNVERIFIED claim flagged explicitly as a **docstring/behavior
mismatch** in `## Blocking`, not silently folded into the generic count — this is the
exact class of drift the gate exists to catch.

### Prose docs (`CLAUDE.md`, `AGENTS.md` narrative sections, `.agentic/guides/*`)
Claims are the concrete assertions embedded in prose/tables (file paths, counts,
"X must PASS before Y"). Skip stylistic or advisory language.

### Fleet/registry tables (`AGENTS.md`, `agent-registry.md`)
Every row is itself a set of claims: a `write_scope` cell must match the named
agent's actual `.agentic/agents/<name>.md` frontmatter `write_scope`; a "must PASS"
cell must match that agent's actual gate status. Grade the whole table as
(verified cells / total cells), not as one claim.

### Generated agent contracts and guides — the discovery record is never a citable source
A mandatory rule in a generated `.agentic/agents/*.md` contract or a generated
`.agentic/guides/**/*.md` guide must cite a real repo file (`path:line`) or a
scaffolded guide by path. If a rule instead cites `journal.stack_discovery`,
"the stack-fact record," "the discovery record," or equivalent phrasing as its
evidence, that claim is **UNVERIFIED regardless of whether the underlying fact
is true** — the record is documented (`generators/stack-discovery.md` §
Evidence guarantee) as an unverified hint for the generator to re-confirm, not
a source a generated file may point a reader at. Flag this explicitly in
`## Blocking` as a **discovery-record citation** finding, not folded into the
generic unverified count, so it's visible as the specific class of drift this
check exists to catch.
