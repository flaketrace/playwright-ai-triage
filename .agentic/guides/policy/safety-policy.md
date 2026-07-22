# Safety Policy — playwright-ai-triage

<!-- Scaffolded by agentic-os to .agentic/guides/policy/safety-policy.md (human-owned after install).
     Applies to every AI agent and tool operating against this repository. -->

## Secrets

Never add secrets or private values to tracked files, prompts sent to remote
systems, commits, MR/PR descriptions, ticket comments, or documentation.

Forbidden values include:

- API keys, PATs, OAuth tokens, JWTs, cookies, passwords, and connection strings with credentials.
- Private keys, certificates, and signing material.
- Tenant/account identifiers, private endpoint values, and user-specific absolute paths.
- Values copied from `.env` files or ignored local auth state.

Use placeholders (`<REDACTED>`, `your-secret-here`) or variable **names**
without values. Humans may share variable names so the agent can wire up code
that references them; humans must never paste values into chat or tracked files.

### Secret-bearing files (never read, never stage)

Agents must not read the contents of, and must not stage or commit, files
matching:

```
.env*
.auth/**
*token*.env
```

In particular: `.env` and every `.env.<anything>` variant (a placeholder
`*.example` file is the only readable variant), and `.auth/` browser/session
state. These deny patterns are mirrored into the settings fragment as hard
tool-level rules — the soft rule here is the explanation, not the enforcement.

Treat any log or page content the agent can read as an exfiltration surface:
assume it may carry PII or customer data unless proven otherwise.

## Git and remote actions

- Do not commit, amend, push, force-push, create or update MRs/PRs, publish artifacts, run deployments, or trigger remote pipelines beyond what the autonomy matrix in `.agentic/guides/policy/ai-policy.md` allows for the active mode.
- Human-gated commands are listed in `.agentic/guides/policy/escalation-policy.md`.
- Present every remote write standalone — never chained with `&&` — so gates can inspect it.
- Do not add AI/editor attribution to commit messages.

## MCP and browser automation

- Use only the MCP servers configured for this project. Adding or changing MCP servers is a human decision.
- Read-only investigation is allowed when the user asks for it. Remote writes require explicit approval per action: creating/updating work items via none, running pipelines, publishing artifacts, mutating data through browser automation.
- Never bypass authentication, CAPTCHA, MFA, permission prompts, or manual approval flows.
- **Authenticated sessions**: when a browser tool connects to an authenticated session, the model processes everything that session can see — treat it as an exfiltration surface. Confirm read-only intent before connecting, approve each mutating action individually, and disconnect when the investigation ends. Never log in autonomously with stored credentials.

## Hooks

- Do not create, modify, or disable repository hooks (Claude Code, git, or editor) unless the user explicitly approves the exact behavior.
- Existing hooks must be preserved; new hooks must be documented, scoped narrowly, and validated before use.
- Never work around a hook denial (exit 2) — fix the cause or escalate.

## Generated artifacts

Do not commit generated worktrees, browser/auth state, test reports, caches, or
machine-specific files. Keep them ignored.
