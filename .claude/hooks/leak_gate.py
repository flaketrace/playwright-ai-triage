#!/usr/bin/env python3
# Claude Code PreToolUse(Bash) hook — blocks publication of work-environment data.
#
# Born from a real incident: identifiers from a private environment reached public
# surfaces of this repo (a PR body, code comments, captured fixtures), and scrubbing
# after the fact proved far more costly than preventing it — published content is
# effectively unrecallable. This gate makes the mistake impossible to repeat by
# scanning everything at the moment it would leave the machine:
#
#   git commit  -> staged diff (text) + the commit message arguments
#   git push    -> full diff of every outgoing commit vs the remote ref
#   gh pr/issue/release/api, npm publish -> the whole command text (bodies included)
#
# Patterns come from two places, merged (union):
#   ~/.claude/leak_patterns.txt              — machine-global, guards every repo on
#                                              this machine with one list
#   .claude/hooks/leak_patterns.txt          — optional repo-local overlay (gitignored)
# One case-insensitive regex per line; the pattern files are themselves confidential
# and must never be committed or quoted. When NEITHER file exists — a contributor's
# clone — the gate warns (per publish command) and allows: the list is the maintainer's,
# and this hook must not break everyone else's commits.
# Deliberate false-positive bias: blocking a legitimate command costs one override —
# LEAK_OK=1 <command> — while a miss costs an unrecoverable disclosure.
#
# stdin:  PreToolUse event {"tool_name": "Bash", "tool_input": {"command": "..."}}
# exit:   2 to block, 0 to allow.

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

GLOBAL_PATTERNS_FILE = Path.home() / ".claude" / "leak_patterns.txt"
OVERLAY_PATTERNS_FILE = Path(__file__).resolve().parent / "leak_patterns.txt"
# Maintainer machines create this marker once; when present, a MISSING pattern list
# blocks instead of warning — so losing/renaming the confidential list can never
# silently disarm the gate on the machine it exists to protect. Contributors never
# have the marker, so clones stay warn-and-allow.
STRICT_MARKER_FILE = Path.home() / ".claude" / ".leak_gate_required"

# Commands that publish content to an external service. `git commit` is included:
# post-commit scrubbing already proved costly (amend + force-push + Support), so the
# boundary sits at the commit, not just the push.
PUBLISH_RE = re.compile(
    r"\bgit\s+(commit|push)\b|\bgh\s+(pr|issue|release|api|gist)\b|\bnpm\s+publish\b"
)

MAX_SCAN_BYTES = 5 * 1024 * 1024  # a diff bigger than this is scanned truncated


def load_patterns() -> list[re.Pattern[str]] | None:
    """Union of the global list and the repo overlay; None when neither exists.

    None means "no confidential list on this machine" (a contributor's clone) —
    the caller warns and allows. An EXISTING but empty/unreadable file is still an
    error: for the maintainer, a silently toothless gate is worse than a broken one.
    """
    sources = [p for p in (GLOBAL_PATTERNS_FILE, OVERLAY_PATTERNS_FILE) if p.exists()]
    if not sources:
        return None
    patterns: list[re.Pattern[str]] = []
    for source in sources:
        for line in source.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            patterns.append(re.compile(line, re.IGNORECASE))
    if not patterns:
        raise RuntimeError(f"pattern file(s) present but no patterns loaded: {sources}")
    return patterns


def run_git(*args: str) -> str:
    proc = subprocess.run(
        ["git", *args], capture_output=True, text=True, timeout=30, check=False
    )
    return proc.stdout if proc.returncode == 0 else ""


def outgoing_diff() -> str:
    """Diff of everything a push would make public: upstream..HEAD, or the full
    branch vs origin's default branch when there is no upstream yet."""
    upstream = run_git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").strip()
    base = upstream if upstream else "origin/main"
    return run_git("log", "-p", "--format=%B", f"{base}..HEAD")


def scan(text: str, patterns: list[re.Pattern[str]]) -> list[str]:
    """Returns opaque hit labels (pattern INDEX, 1-based), never pattern text:
    echoing the confidential pattern back would put it in the agent's context,
    one paraphrase away from published prose."""
    found: list[str] = []
    for i, pattern in enumerate(patterns, 1):
        if pattern.search(text):
            found.append(f"#{i}")
    return found


def gate() -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)

    cmd = (event.get("tool_input") or {}).get("command", "")
    if not cmd or not PUBLISH_RE.search(cmd):
        sys.exit(0)

    # Explicit, loud override — for the rare legitimate use of a listed term.
    if re.search(r"\bLEAK_OK=1\b", cmd):
        print("[leak-gate] LEAK_OK=1 override used — content NOT scanned.", file=sys.stderr)
        sys.exit(0)

    patterns = load_patterns()
    if patterns is None:
        if STRICT_MARKER_FILE.exists():
            print(
                "[leak-gate] BLOCKED: this machine is marked leak-gate-required "
                f"({STRICT_MARKER_FILE}) but no pattern list was found at "
                f"{GLOBAL_PATTERNS_FILE} or the repo overlay — restore the list "
                "before publishing.",
                file=sys.stderr,
            )
            sys.exit(2)
        print(
            "[leak-gate] no pattern list on this machine "
            f"({GLOBAL_PATTERNS_FILE} and repo overlay both absent) — allowing. "
            "Maintainers keep a confidential list there; contributors can ignore this.",
            file=sys.stderr,
        )
        sys.exit(0)

    # The command text itself (gh pr bodies, commit -m messages, heredocs).
    corpus = [("command text", cmd)]

    if re.search(r"\bgit\s+commit\b", cmd):
        corpus.append(("staged diff", run_git("diff", "--cached")[:MAX_SCAN_BYTES]))
    if re.search(r"\bgit\s+push\b", cmd):
        corpus.append(("outgoing commits", outgoing_diff()[:MAX_SCAN_BYTES]))

    for label, text in corpus:
        hits = scan(text, patterns)
        if hits:
            shown = ", ".join(hits[:5]) + (" …" if len(hits) > 5 else "")
            print(
                f"[BLOCKED] leak-gate: {label} matches confidential work-identifier "
                f"pattern(s): {shown}\n"
                "Work-project data must never reach this public repo — sanitize the "
                "content (neutral names, paraphrased quotes, synthesized fixtures) and "
                "retry. Do NOT quote the matched pattern in any published text. "
                "Legitimate false positive: prefix the command with LEAK_OK=1.",
                file=sys.stderr,
            )
            sys.exit(2)

    sys.exit(0)


def main() -> None:
    # Fail CLOSED for publish commands: if the gate cannot evaluate, it must block —
    # an exit 1 is non-blocking in PreToolUse and would silently disable the boundary.
    try:
        gate()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — deliberate catch-all for fail-closed
        print(f"[leak-gate] internal error, blocking to fail closed: {e!r}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
