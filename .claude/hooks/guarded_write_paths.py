#!/usr/bin/env python3
# Claude Code PreToolUse(Write|Edit) hook — blocks writes to guarded paths.
#
# A guarded path is writable only via its named human-gated flow (e.g. a design
# lock file changed only through a dedicated review command). Any direct
# Write/Edit is blocked (exit 2). The list's source of truth is
# .agentic/guides/policy/escalation-policy.md; this file is rendered from it at
# install time.
#
# stdin:  PreToolUse event {"tool_name": "Write"|"Edit",
#                           "tool_input": {"file_path": "..."}}
# exit:   2 to block, 0 to allow.

from __future__ import annotations

import json
import sys

# One path substring per line; a Write/Edit whose file_path contains any of
# them is blocked. Optional " => <flow>" suffix names the allowed flow for the
# block message.
GUARDED_WRITE_PATHS = """"""


def gate() -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)

    # `or {}` — an explicit `"tool_input": null` yields None, and `None.get(...)`
    # raises. An uncaught error exits 1 = non-blocking on PreToolUse, so the
    # guarded write would slip through. See main()'s fail-closed wrapper.
    file_path = (event.get("tool_input") or {}).get("file_path", "")
    if not file_path:
        sys.exit(0)

    for raw in (line.strip() for line in GUARDED_WRITE_PATHS.splitlines()):
        if not raw or raw.startswith("#"):
            continue
        path, _, flow = (part.strip() for part in raw.partition("=>"))
        if path and path in file_path:
            hint = f" Use the '{flow}' flow instead." if flow else ""
            print(
                f"[BLOCKED] {path} requires a human-gated flow.{hint}\n"
                "See .agentic/guides/policy/escalation-policy.md §Human-gated commands.",
                file=sys.stderr,
            )
            sys.exit(2)

    sys.exit(0)


def main() -> None:
    # Fail CLOSED: a block gate that cannot evaluate must block (exit 2), not let a
    # crash become a non-blocking exit 1. Intentional exits pass through unchanged.
    try:
        gate()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — deliberate catch-all for fail-closed
        print(f"[guarded-write] internal error, blocking to fail closed: {e!r}",
              file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
