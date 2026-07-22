#!/usr/bin/env python3
"""PreCompact checkpoint hook (smart context management).

Fires immediately before Claude Code compacts the conversation (manual `/compact`
or auto-compact near the context limit). It snapshots task-critical state to
`.claude/checkpoints/last-compaction.md` so that load-bearing context — the
in-flight change set and a reminder of what must be preserved — survives the
summarization. Compaction can drop transcript detail; this file cannot be dropped.

Contract: never fail the session. Always exit 0.
"""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PRESERVE = (
    "When you resume after compaction, preserve / re-derive:\n"
    "- the active feature spec or task goal\n"
    "- gate-agent results so far (PASS|FAIL per read-only gate in the fleet)\n"
    "- the changed-file list below (work in flight)\n"
    "- any open FAIL items still owed a fix\n"
)


def _git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], capture_output=True, text=True, timeout=10
        ).stdout.strip()
    except Exception:
        return ""


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    trigger = payload.get("trigger", "unknown")  # "manual" | "auto"
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    branch = _git("rev-parse", "--abbrev-ref", "HEAD") or "(unknown)"
    changed = _git("status", "--porcelain") or "(working tree clean)"

    root = _git("rev-parse", "--show-toplevel")
    out_dir = Path(root) / ".claude" / "checkpoints" if root else Path(".claude/checkpoints")
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "last-compaction.md").write_text(
            f"# Pre-compaction checkpoint\n\n"
            f"- when: {ts}\n"
            f"- trigger: {trigger}\n"
            f"- branch: {branch}\n\n"
            f"## Preserve\n{PRESERVE}\n"
            f"## Changed files at compaction\n```\n{changed}\n```\n",
            encoding="utf-8",
        )
        sys.stdout.write(
            "[precompact] checkpoint written to "
            ".claude/checkpoints/last-compaction.md — re-read it after compaction "
            "to recover the in-flight change set and gate state.\n"
        )
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
