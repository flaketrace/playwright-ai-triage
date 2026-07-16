# Security Policy

## Supported versions

Only the latest published release receives security fixes. The package is pre-1.0; there are no
maintenance branches.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: **Security tab → Report a vulnerability**
on this repository. If that option is unavailable, email **y.krivushenko@gmail.com** with
`[playwright-ai-triage security]` in the subject. Do not open a public issue for anything you
believe is exploitable.

You can expect an acknowledgment within a few days. Please include the reporter version, a
minimal reproduction, and the impact you see.

## Scope: what this tool does with your data

The reporter runs inside your CI and sends redacted failure text to two kinds of destinations
you control: the Anthropic API and the outputs you enable (GitHub PR comment, Slack webhook).
The exact field list is documented in the README section
["What data is sent where"](README.md#what-data-is-sent-where). Screenshots, videos, traces,
and source code (beyond stack frames and whatever you opt into via `GIT_DIFF_SUMMARY`) are
never uploaded.

Reports we consider security vulnerabilities include:

- **Redaction bypass** — a secret matching the redaction patterns (see `src/redact.ts`, or an
  env-var value the reporter masks) reaching the Anthropic API, a PR comment, or Slack in
  clear text.
- **Output injection** — untrusted test output (error messages, test titles, DOM snippets)
  escaping the renderer's sanitization in a PR comment or Slack message.
- **Build-integrity violations** — the reporter changing your suite's exit code or executing
  code it shouldn't (the package intentionally has no install hooks).
- Supply-chain issues in the published artifact (releases are OIDC trusted-published with SLSA
  provenance; anything inconsistent with that is worth reporting).

## A note on redaction

Redaction is best-effort and pattern-based. It is a defense-in-depth layer, not a guarantee:
unusual secret formats may not be masked. Treat your test environment's secrets as you would
for any tool that reads CI output — scoped, short-lived, and never printed on purpose.
