# Project Context

<!-- Rendered by /agentic-init. agentic-sdlc reads this file to resolve the
     ticket and MR adapters; keep adapter configuration ONLY in the two
     Adapter sections below — do not duplicate it elsewhere. -->

## Project Identity

| Field | Value | Source |
|---|---|---|
| Project name | playwright-ai-triage | interview / repo manifest |
| Project code/key | none | interview |

## Work Item Tracker

| Field | Value |
|---|---|
| Provider | none |
| Key/prefix | none |

## Ticket Adapter

**Status**: configured
**Adapter**: none
**Lookup**: resolve a `none-NNN` identifier to title, description, and
acceptance criteria using the provider named above (MCP tools when available,
otherwise the provider CLI). If the provider is `none`, skills that need a ticket
fall back to free-form task descriptions.
**Create**: create work items through the same provider; always show the full
payload and get human confirmation before any external write.
**Output**: work-item identifier and URL.

## Source Control And Review

| Field | Value |
|---|---|
| Default target branch | main |
| Review artifact type | MR/PR via gh |

## MR Adapter

**Status**: configured
**Adapter**: gh
**Instructions**: branches follow `feature/*` / `fix/*` naming and target
**`main`**. Reference the `none-NNN` work item in the
MR/PR body when one exists. Conventional commit messages; no AI attribution
footers. Production promotion is human-gated (see
`.agentic/guides/policy/escalation-policy.md`).
