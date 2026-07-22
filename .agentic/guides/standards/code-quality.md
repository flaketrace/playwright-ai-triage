# Code Quality Standards

Blocking standards — deviating requires the owner's explicit say-so in chat, never silently.

## Tests & gates

### Every PR MUST pass the blocking gates
The project's gate commands are catalogued in
[`quality-gates.md`](quality-gates.md) (populated at install time from the detected
stack). If a gate fails, the agent fixes the underlying issue — never bypasses the
gate. No `--no-verify`, no skipped cases, no commenting out the failing test.

### Blind review before commit
Every `git commit` is preceded by a blind-code-reviewer pass over the exact staged
diff. The reviewer gets a one-paragraph functional brief only — never the author's
reasoning — so it cannot be talked into agreement. Enforced twice: the PreToolUse
hook (`.claude/hooks/precommit_review_gate.py`) and the native git pre-commit hook
(`.githooks/pre-commit`, maintainer-local — not in the public tree). Any further `git add` invalidates the approval stamp
(it is the sha256 of the staged diff) and requires a fresh review.

### New pure logic gets a unit test
Extract decision logic from I/O-heavy code into pure helpers and test those. A bug
fix ships with the test that would have caught it.

## Comments, docs, dead code

### MUST NOT write comments explaining *what* code does
Variable names cover it.

### SHOULD write a one-line comment when the *why* is non-obvious
A workaround, a constraint, a known quirk. Reference the change or bug it ties to.

### MUST NOT leave commented-out code, dead branches, or undated TODOs
`// TODO: remove after launch` needs a date or a condition, or it doesn't ship.

### MUST NOT add a README to a directory for the sake of having one
If there's a load-bearing convention, document it in the relevant guide under
`.agentic/guides/`. New `.md` files must be referenced from an existing index within
the same change, or deleted.

## Reports & terseness (agents)

Inline reports: one section per finding, code refs as `file:line`. No "Executive
Summary", no "Conclusion", no emoji.

## How to propose a change

These standards are living. New rule: add it to the right guide under
`.agentic/guides/`, quote the bug/change it came from, PR title
`docs(standards): <rule short title>`. Only the owner can approve removing or
weakening a rule.
