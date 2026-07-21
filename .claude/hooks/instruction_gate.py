#!/usr/bin/env python3
"""Claude Code SubagentStart hook — instruction-quality blocking gate.

stdin:  the SubagentStart event. The harness's exact field name for the spawned
        agent's identifier varies by version, so this reads defensively across
        the plausible key names in AGENT_NAME_KEYS. Verify the real key against
        your harness's SubagentStart payload during rollout and adjust if needed.
stdout: nothing (block reason goes to stderr)
exit:   2 to block (agent's contract is stale/ungraded/below threshold), 0 to allow.

Gates every agent that has a canonical contract in .agentic/agents/ (not
just gate-role agents — a stale contract for a writer agent is as dangerous as a
stale gate contract). Per spawn, checks:
  1. That agent's own .agentic/agents/<name>.md + .claude/agents/<name>.md
  2. CLAUDE.md, AGENTS.md, PATTERNS.md (the index files every agent reads first)
  3. Any .agentic/guides/*.md file cited in the agent's own canonical contract

Per-agent threshold overrides: a scorecard entry may carry "gate_threshold"; it
takes precedence over the default. This is how below-threshold generated agents
install with a relaxed, visible, tracked gate instead of a hard block.

Circular-bootstrap exception: spawning instruction-auditor itself is FULLY exempt
from this gate. It is the read-only repair path — when any governed file (including
CLAUDE.md/AGENTS.md/PATTERNS.md) goes stale, the documented unblock is to spawn
instruction-auditor to re-grade it; gating that spawn on the same stale file would
deadlock the whole fleet.

Known caveats (verify on first real spawn): (a) the agent-name key is read
defensively across AGENT_NAME_KEYS — if none match, the gate prints a loud stderr
note and allows, so the failure mode is observable, never silent; (b) whether the
harness honors exit 2 as a block on SubagentStart (vs PreToolUse, where it is
documented) varies by harness version — /agentic-doctor probes this.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys

SCORECARD_PATH = "docs/audits/instruction-scorecard.json"
SCORE_THRESHOLD = 95
AGENTS_CANONICAL_DIR = ".agentic/agents/"

CORE_INDEX_FILES = ["CLAUDE.md", "AGENTS.md", "PATTERNS.md"]
AGENT_NAME_KEYS = ("subagent_type", "agent_type", "agentType", "subagentType", "name")


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


def load_scorecard(root: str) -> "dict | None":
    """None = no scorecard FILE (a contributor clone — the grading pipeline and its
    docs/audits/ output are maintainer-local and gitignored): the caller allows with
    a note. A file that exists but fails to parse returns empty ⇒ every agent blocks
    as "never graded" — on a maintainer machine a corrupt scorecard must fail closed,
    not silently wave agents through."""
    path = os.path.join(root, SCORECARD_PATH)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        # present but unreadable/corrupt: return empty so every agent blocks —
        # the block reason will say the scorecard needs REPAIR, not re-grading
        print(f"[instruction-gate] scorecard at {path} exists but cannot be parsed — "
              "fix the JSON; all governed spawns block until then.", file=sys.stderr)
        return {"files": {}}


def sha256_of(path: str) -> "str | None":
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None


# Match bare guide paths anywhere in the text (no parens context — a greedy
# paren-bounded regex mis-extracts when prose parentheticals contain other .md
# names after the guide path).
CITED_GUIDE_RE = re.compile(r"\.agentic/guides/[\w./-]+?\.md")


def cited_guides(canonical_path: str) -> "list[str]":
    try:
        with open(canonical_path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return []
    return sorted(set(m.group(0) for m in CITED_GUIDE_RE.finditer(text)))


def block(agent_name: str, rel: str, reason: str, threshold: int) -> None:
    print(
        f"[instruction-gate] Cannot spawn '{agent_name}': {rel} is {reason}.\n"
        f"Run: /instruction-auditor {rel}   (or /instruction-auditor --all for a full sweep)\n"
        f"This blocks until {rel}'s composite_score >= {threshold} in {SCORECARD_PATH}.",
        file=sys.stderr,
    )
    sys.exit(2)


def main() -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)

    agent_name = ""
    for key in AGENT_NAME_KEYS:
        val = event.get(key)
        if isinstance(val, str) and val:
            agent_name = val
            break

    if not agent_name:
        # No recognized agent-name key: surface it loudly instead of silently
        # allowing forever. Allow, but make the gap visible.
        print(
            "[instruction-gate] SubagentStart payload had no recognized "
            f"agent-name key (looked for: {', '.join(AGENT_NAME_KEYS)}; got: "
            f"{', '.join(sorted(event.keys())[:8])}). Gate inactive for this "
            "spawn — update AGENT_NAME_KEYS in .claude/hooks/instruction_gate.py.",
            file=sys.stderr,
        )
        sys.exit(0)

    root = repo_root()

    own_canonical = os.path.join(AGENTS_CANONICAL_DIR, f"{agent_name}.md")
    if not os.path.isfile(os.path.join(root, own_canonical)):
        sys.exit(0)  # no canonical contract — not a governed agent, nothing to gate

    if agent_name == "instruction-auditor":
        # Full exemption: the auditor is the read-only repair path. Gating it on
        # the staleness of the very file it is being spawned to re-grade (incl.
        # the core index files) would deadlock the whole fleet.
        sys.exit(0)

    loaded = load_scorecard(root)
    if loaded is None:
        print(
            f"[instruction-gate] no scorecard at {SCORECARD_PATH} — instruction "
            "grading is maintainer-local; allowing this spawn (contributor clone).",
            file=sys.stderr,
        )
        sys.exit(0)
    scorecard = loaded.get("files", {})

    check_paths = list(CORE_INDEX_FILES)
    own_pointer = f".claude/agents/{agent_name}.md"
    check_paths.append(own_canonical)
    check_paths.append(own_pointer)
    check_paths.extend(cited_guides(os.path.join(root, own_canonical)))

    for rel in check_paths:
        abs_path = os.path.join(root, rel)
        current_hash = sha256_of(abs_path)
        if current_hash is None:
            continue  # file missing — structural checks own that failure mode, not this gate
        entry = scorecard.get(rel)
        threshold = SCORE_THRESHOLD
        if isinstance(entry, dict) and isinstance(entry.get("gate_threshold"), (int, float)):
            threshold = entry["gate_threshold"]
        if entry is None:
            block(agent_name, rel, "never graded", threshold)
        if entry.get("content_sha256") != current_hash:
            block(agent_name, rel, "stale (content changed since last grading)", threshold)
        composite = entry.get("composite_score")
        if composite is None:
            block(agent_name, rel, "structural-only, not evidence-graded", threshold)
        if composite < threshold:
            block(agent_name, rel, f"below threshold ({composite}% < {threshold}%)", threshold)

    sys.exit(0)


def _guarded_main() -> None:
    # Fail CLOSED like the sibling gates: an uncaught exception would exit 1, which
    # is NON-blocking on SubagentStart — a structurally-corrupt scorecard (valid
    # JSON, wrong shape) must block, not silently wave the spawn through.
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — deliberate catch-all for fail-closed
        print(f"[instruction-gate] internal error, blocking to fail closed: {e!r}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    _guarded_main()
