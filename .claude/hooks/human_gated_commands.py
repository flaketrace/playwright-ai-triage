#!/usr/bin/env python3
# Claude Code PreToolUse(Bash) hook — blocks human-gated shell commands.
#
# A command matching any substring in HUMAN_GATED_COMMANDS is permanently
# human-in-the-loop: the hook blocks it (exit 2) and tells the agent to stop
# and escalate. See .agentic/guides/policy/escalation-policy.md for the list's
# source of truth; this file is rendered from it at install time.
#
# stdin:  PreToolUse event {"tool_name": "Bash", "tool_input": {"command": "..."}}
# exit:   2 to block, 0 to allow.

from __future__ import annotations

import json
import sys

# One substring per line; a Bash command containing any of them is blocked.
HUMAN_GATED_COMMANDS = """git push origin main"""


def gate() -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)

    # `or {}` — an explicit `"tool_input": null` yields None, not the default, and
    # `None.get(...)` raises AttributeError. An uncaught error exits 1, which
    # PreToolUse treats as NON-blocking — the gated command would slip through.
    cmd = (event.get("tool_input") or {}).get("command", "")
    if not cmd:
        sys.exit(0)

    for gated in (line.strip() for line in HUMAN_GATED_COMMANDS.splitlines()):
        if gated and not gated.startswith("#") and gated in cmd:
            # Exit 2 + stderr is the only PreToolUse block signal every runtime honors.
            print(
                f"[BLOCKED] Human-gated operation: {gated}\n"
                "See .agentic/guides/policy/escalation-policy.md §Human-gated commands. "
                "Stop and escalate to the user.",
                file=sys.stderr,
            )
            sys.exit(2)

    sys.exit(0)


def main() -> None:
    # Fail CLOSED: a block gate that cannot evaluate its input must block (exit 2),
    # never let the crash become a non-blocking exit 1 that silently disables it.
    # Intentional exit codes (SystemExit from gate()) pass through unchanged.
    try:
        gate()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — deliberate catch-all for fail-closed
        print(f"[human-gated] internal error, blocking to fail closed: {e!r}",
              file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
