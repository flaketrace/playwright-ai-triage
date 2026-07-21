# Git Workflow

Canonical git conventions for this repository. Concrete values (default branch,
human-gated commands, ticket prefix) live in `.agentic/guides/project.md` and
`.agentic/guides/policy/escalation-policy.md` — this guide defines the process rules.

## Branch hierarchy

```
<production branch>            (protected — releases only)
 └── <integration branch>     (agents PR here; see project.md for the branch names)
      └── feature/* · fix/*   (short-lived, branch from the integration branch)
```

- All feature/fix work branches from an up-to-date integration branch and lands there via PR/MR.
- Direct pushes to the production branch are human-gated (hook-enforced — see below).
- The SessionStart hook fetches and REPORTS drift vs the integration branch at session start — integration itself is always an explicit command, never automatic.

## Branch naming convention

Pattern: `feature/<topic>` or `fix/<topic>` (kebab-case)
Example: `feature/reply-composer`, `fix/editor-empty-state`

## Commit message format

Format: conventional commits — `<type>(<scope>): <description>`
Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`
Example: `feat(chat): add reply-to preview in composer`

- Reference the work item in the body when one exists (prefix per `project.md`).
- **Never add Co-Authored-By or any AI attribution** to commits.

## Merge strategy

- **Into the integration branch**: PR/MR merge with green CI. A pipeline gate
  (sync + mergeability + checks) should verify readiness before merge.
- **Into the production branch**: only via the project's release flow, human-triggered.
  Agents never push, tag, or merge to production directly.

## Sync before work

```bash
git fetch origin
git checkout <integration-branch> && git pull --ff-only origin <integration-branch>
git checkout -b feature/your-topic
# on an existing feature branch: git merge origin/<integration-branch> (or rebase)
# before push/PR: merge the integration branch again, then push
```

Never commit on a stale base; resolve conflicts or escalate first.

## Anti-patterns

| Bad | Good |
|---|---|
| PR targeting the production branch | PR targeting the integration branch |
| Manual push/tag to production | The project's human-triggered release flow |
| Branch feature work from the production branch | Branch from the up-to-date integration branch |
| `fixed stuff` commit message | `fix(forum): restore thread pagination cursor` |
| Commit with Co-Authored-By footer | Plain conventional commit |
| `--no-verify` past the pre-commit review gate | Get the staged diff reviewed, then commit |

## Hard blocks (hook-enforced)

`.claude/hooks/human_gated_commands.py` (PreToolUse) blocks the commands listed in
`.agentic/guides/policy/escalation-policy.md` §Human-gated operations — by default that
includes pushes to the production branch. The native git `pre-commit` hook
(`.githooks/pre-commit`, maintainer-local, installed via `bash scripts/install-git-hooks.sh`, also maintainer-local) blocks any
commit whose staged diff has not passed blind review — see
`.agentic/guides/standards/code-quality.md` §Blind review before commit.

## Troubleshooting

- Repeated sync failures or parallel worktrees touching the same files → stop and escalate.
- A hook block you believe is wrong → do not bypass; surface it to the human with the
  hook's stderr output.
