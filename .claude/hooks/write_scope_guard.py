#!/usr/bin/env python3
# write_scope_guard.py — per-agent write-scope enforcement.
#
# Reads .agentic/state/active-agent.json (written by an orchestrator) and
# compares the edited file against the active agent's declared write_scope.
# When no lock file exists the guard is a no-op (open mode).
#
# Two modes selected by argv[1]:
#   warn  — advisory hook: prints a WARNING to stderr, never blocks.
#   block — PreToolUse Write/Edit hook (Claude Code): exits 2 to block the write.
#
# Lock file format (.agentic/state/active-agent.json):
#   {"agent": "action-author"}
#
# The agent name must match a .agentic/agents/<name>.md frontmatter where
# write_scope lists glob patterns. A file outside every pattern is out-of-lane.
#
# Event formats:
#   advisory       stdin: {"file_path": "..."}
#   PreToolUse     stdin: {"tool_name": "Write"|"Edit",
#                          "tool_input": {"file_path": "..."}}

from __future__ import annotations

import fnmatch
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE_FILE = ROOT / ".agentic" / "state" / "active-agent.json"
AGENTS_DIR = ROOT / ".agentic/agents/"


def load_active_agent() -> str | None:
    try:
        data = json.loads(STATE_FILE.read_text())
        return data.get("agent")
    except (OSError, json.JSONDecodeError):
        return None


def parse_fm_list(agent_name: str, key: str) -> list[str]:
    agent_file = AGENTS_DIR / f"{agent_name}.md"
    try:
        text = agent_file.read_text()
    except OSError:
        return []
    if not text.startswith("---"):
        return []
    end = text.find("\n---", 3)
    if end == -1:
        return []
    fm_lines = text[3:end].split("\n")
    scope: list[str] = []
    in_scope = False
    for raw in fm_lines:
        line = raw.rstrip()
        if re.match(rf"^{key}\s*:", line):
            val = line.split(":", 1)[1].strip()
            if val and val != "[]":
                scope.append(val)
            else:
                in_scope = True
            continue
        if in_scope:
            m = re.match(r"^\s+-\s+(.+)", line)
            if m:
                entry = m.group(1).strip().split("#")[0].strip()
                if entry:
                    scope.append(entry)
            elif line and not line.startswith(" "):
                in_scope = False
    return scope


def in_scope(file_path: str, patterns: list[str]) -> bool:
    try:
        rel = Path(file_path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return True  # outside repo — not our concern
    # Prefix matches must respect path-segment boundaries: a scope of `app/`
    # must NOT permit a sibling like `app-legacy/`.
    return any(fnmatch.fnmatch(rel, pat.rstrip("/") + ("/*" if pat.endswith("/") else "")) or
               fnmatch.fnmatch(rel, pat) or
               rel == pat.rstrip("/") or
               rel.startswith(pat.rstrip("/") + "/")
               for pat in patterns)


def get_file_path(event: dict) -> str:
    fp = event.get("file_path") or event.get("file") or ""
    if not fp:
        # `or {}` — an explicit `"tool_input": null` yields None, and `None.get(...)`
        # raises; in block mode an uncaught error exits 1 = non-blocking, so an
        # out-of-lane write would slip through. main()'s wrapper also fails closed.
        inp = event.get("tool_input") or {}
        fp = inp.get("file_path") or inp.get("path") or ""
    return fp


def guard(mode: str) -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)

    agent_name = load_active_agent()
    if not agent_name:
        sys.exit(0)  # no lock active — open mode

    scope_patterns = parse_fm_list(agent_name, "write_scope")
    forbidden_patterns = parse_fm_list(agent_name, "forbidden_paths")
    if not scope_patterns and not forbidden_patterns:
        sys.exit(0)  # nothing declared or agent not found

    file_path = get_file_path(event)
    if not file_path:
        sys.exit(0)

    # forbidden_paths is a deny-list and takes precedence over write_scope.
    if forbidden_patterns and in_scope(file_path, forbidden_patterns):
        deny = (
            f"[write-scope] {agent_name} declares forbidden_paths: {forbidden_patterns}.\n"
            f"  File '{file_path}' matches a forbidden path — this write is denied\n"
            f"  regardless of write_scope. To unlock: delete .agentic/state/active-agent.json"
        )
        print(deny, file=sys.stderr)
        sys.exit(2 if mode == "block" else 0)

    if not scope_patterns or in_scope(file_path, scope_patterns):
        sys.exit(0)

    msg = (
        f"[write-scope] {agent_name} declared write_scope: {scope_patterns}.\n"
        f"  File '{file_path}' is outside its lane.\n"
        f"  Review whether this write is intentional or an orchestration error.\n"
        f"  To unlock: delete .agentic/state/active-agent.json"
    )

    if mode == "block":
        # Exit 2 + stderr is the only PreToolUse block signal every runtime honors;
        # exit 1 is a non-blocking hook error on this harness and would let the
        # write through silently.
        print(msg, file=sys.stderr)
        sys.exit(2)
    else:
        print(msg, file=sys.stderr)
        sys.exit(0)


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "warn"
    # Fail CLOSED in block mode: a guard that cannot evaluate its input must block
    # (exit 2), never let a crash become a non-blocking exit 1. warn mode is
    # advisory, so an error there stays non-blocking (exit 0). Intentional exits
    # (SystemExit from guard()) pass through unchanged.
    try:
        guard(mode)
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — deliberate catch-all for fail-closed
        print(f"[write-scope] internal error: {e!r}", file=sys.stderr)
        sys.exit(2 if mode == "block" else 0)


if __name__ == "__main__":
    main()
