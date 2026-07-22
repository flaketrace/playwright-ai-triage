#!/usr/bin/env python3
"""Claude Code PostToolUse(Edit|Write) hook — instruction-quality staleness notice.

stdin:  {"tool_input": {"file_path": ...}}
stdout: one advisory line when the edited governed file is stale/ungraded (same
        channel as the other PostToolUse advisory notices in
        .claude/settings.json), nothing otherwise
exit:   always 0 — this hook NEVER blocks.

Governed files (agent contracts, command mirrors, guides, root index files, Cursor
rules, hook scripts) are graded by the `instruction-auditor` gate on a composite score
persisted in docs/audits/instruction-scorecard.json. This hook only detects that an
edited governed file's content no longer matches its last-graded sha256 and prints a
one-line reminder to re-grade — it never triggers grading itself (grading stays fully
lazy; see the blocking SubagentStart gate in instruction_gate.py for the actual
enforcement point). Same sha256-hash-compare pattern as precommit_review_gate.py.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys

GOVERNED_PATTERNS = [
    re.compile(r"^\.cursor/agents/.*\.md$"),
    re.compile(r"^\.claude/agents/.*\.md$"),
    re.compile(r"^\.claude/commands/.*\.md$"),
    re.compile(r"^\.agentic/guides/.*\.md$"),
    re.compile(r"^CLAUDE\.md$"),
    re.compile(r"^AGENTS\.md$"),
    re.compile(r"^PATTERNS\.md$"),
    re.compile(r"^\.cursor/rules/.*\.mdc$"),
    re.compile(r"^\.claude/hooks/.*\.py$"),
    re.compile(r"^\.cursor/hooks/.*\.py$"),
]


def repo_root() -> str:
    import subprocess

    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except Exception:
        return os.getcwd()


def is_governed(rel: str) -> bool:
    return any(p.match(rel) for p in GOVERNED_PATTERNS)


def load_scorecard(root: str) -> dict:
    path = os.path.join(root, "docs", "audits", "instruction-scorecard.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except OSError:
        return {"files": {}}
    except json.JSONDecodeError:
        return {"files": {}}


def main() -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)

    file_path = event.get("tool_input", {}).get("file_path", "") or ""
    if not file_path:
        sys.exit(0)

    root = repo_root()
    abs_path = file_path if os.path.isabs(file_path) else os.path.join(root, file_path)
    try:
        rel = os.path.relpath(abs_path, root)
    except ValueError:
        sys.exit(0)
    rel = rel.replace(os.sep, "/")

    if not is_governed(rel):
        sys.exit(0)

    try:
        with open(abs_path, "rb") as fh:
            current_hash = hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        sys.exit(0)  # file gone (e.g. deleted) — nothing to notice about

    scorecard = load_scorecard(root)
    entry = scorecard.get("files", {}).get(rel)

    if entry is None:
        sys.stdout.write(
            f"[instruction-quality] {rel} has no recorded score yet. "
            f"Grade it before relying on it: /instruction-auditor {rel}\n"
        )
    elif entry.get("content_sha256") != current_hash:
        sys.stdout.write(
            f"[instruction-quality] {rel} changed since last grading (score now stale). "
            f"Re-grade before spawning dependents: /instruction-auditor {rel}\n"
        )
    sys.exit(0)


if __name__ == "__main__":
    main()
