#!/usr/bin/env python3
# agentic-os output-contract gate — Stop / SubagentStop hook.
#
# Parses the agent output contract (Summary,Why,Blocking,Non-blocking,Escalate to human) from the last
# assistant message of the session transcript and enforces the escalation ladder:
#
#   - '## Summary' first line contains FAIL          -> exit 2 (block)
#   - '## Blocking' non-empty (not None/Nothing)     -> exit 2, items on stderr;
#     the parent must stop and surface them — no silent auto-retry.
#   - '## Escalate to human' non-empty               -> exit 2, instructing the
#     parent to call AskUserQuestion with the listed options before proceeding.
#   - SubagentStop with any contract section missing -> exit 2 (fail-closed:
#     malformed output is treated as Blocking, mirroring decision-router's
#     malformed-JSON escalation).
#   - Ordinary Stop with no contract at all          -> exit 0 (a conversational
#     turn is not a gate report; strictness applies to subagent completions).
#
# stdin (Stop/SubagentStop event):
#   {"session_id": "...", "transcript_path": "/path/to/session.jsonl",
#    "hook_event_name": "Stop"|"SubagentStop", "stop_hook_active": true|false}
#
# Exit 0 = allow. Exit 2 + stderr = block (the only block signal every runtime
# honors; exit 1 is a non-blocking hook error in some runtimes).

from __future__ import annotations

import json
import re
import sys

SECTION_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)

# Rendered by /agentic-init; canonical default:
# Summary,Why,Blocking,Non-blocking,Escalate to human
CONTRACT_SECTIONS = [s.strip() for s in "Summary,Why,Blocking,Non-blocking,Escalate to human".split(",") if s.strip()]


def parse_sections(text: str) -> dict[str, str]:
    matches = list(SECTION_RE.finditer(text))
    sections: dict[str, str] = {}
    for idx, match in enumerate(matches):
        name = match.group(1).strip()
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        sections[name] = text[start:end].strip()
    return sections


def last_assistant_text(transcript_path: str) -> str:
    """Return the text content of the last assistant message in the JSONL transcript."""
    try:
        with open(transcript_path, encoding="utf-8") as fh:
            lines = [ln.strip() for ln in fh if ln.strip()]
    except (OSError, IOError):
        return ""

    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        msg = entry.get("message", entry)  # entries wrap message in 'message' key
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "assistant":
            continue

        content = msg.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
            text = "\n".join(parts)
            if text.strip():
                return text
    return ""


def section_content(sections: dict[str, str], name: str) -> str:
    """Section body with None/Nothing placeholders normalized to empty.

    Only an exact placeholder first line counts as empty — a sentence that merely
    starts with "None of ..." is real content (fail-open would be a gate bypass).
    """
    body = sections.get(name, "").strip()
    first = body.splitlines()[0].strip().lower().rstrip(".") if body else ""
    if first in ("none", "nothing", "n/a", "-"):
        return ""
    return body


def main() -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)

    # Prevent re-entrancy: if this gate already triggered the current turn, exit.
    if event.get("stop_hook_active"):
        sys.exit(0)

    transcript_path = event.get("transcript_path", "")
    if not transcript_path:
        sys.exit(0)

    strict = event.get("hook_event_name") == "SubagentStop"

    text = last_assistant_text(transcript_path)
    if not text:
        # No readable output at all: fail closed for subagents, allow otherwise.
        if strict:
            print("[GATE] Subagent produced no readable final message — fail-closed.",
                  file=sys.stderr)
            sys.exit(2)
        sys.exit(0)

    sections = parse_sections(text)

    if strict:
        missing = [name for name in CONTRACT_SECTIONS if name not in sections]
        if missing:
            print("[GATE] Subagent output is missing required contract section(s): "
                  + ", ".join(f"'## {m}'" for m in missing), file=sys.stderr)
            print("Malformed output is treated as Blocking (fail-closed). "
                  "Re-run the agent with the output contract, or fix its contract template.",
                  file=sys.stderr)
            sys.exit(2)
    elif "Summary" not in sections:
        # Ordinary Stop without a contract: not a gate report.
        sys.exit(0)

    summary = sections.get("Summary", "").strip()
    first_line = summary.splitlines()[0] if summary else ""

    blockers = section_content(sections, "Blocking")
    escalations = section_content(sections, "Escalate to human")

    if "FAIL" in first_line.upper():
        print("[GATE] Agent reported FAIL — pipeline must not advance until resolved.",
              file=sys.stderr)
        print(f"Summary: {first_line}", file=sys.stderr)
        if blockers:
            print("\nBlocking:\n" + blockers, file=sys.stderr)
        else:
            print("\n(No blocking section listed — review the full output manually.)",
                  file=sys.stderr)
        if escalations:
            print("\nEscalate to human:\n" + escalations, file=sys.stderr)
        sys.exit(2)

    if blockers:
        print("[GATE] Agent reported Blocking items — the parent must stop and "
              "surface them (no silent auto-retry):", file=sys.stderr)
        print(blockers, file=sys.stderr)
        sys.exit(2)

    if escalations:
        print("[GATE] Agent requests human decision(s). The parent MUST call "
              "AskUserQuestion with the options listed below before proceeding:",
              file=sys.stderr)
        print(escalations, file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
