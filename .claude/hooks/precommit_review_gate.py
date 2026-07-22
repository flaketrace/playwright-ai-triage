#!/usr/bin/env python3
"""Claude Code PreToolUse(Bash) gate — blind code review before every commit.

Blocks `git commit` until the *exact staged diff* has been reviewed by the
`blind-code-reviewer` subagent and explicitly approved. The approval is a stamp
file holding the sha256 of `git diff --cached`; if the staged content changes
(e.g. the reviewer's findings are fixed), the stamp no longer matches and a
fresh review is required.

Why a stamp instead of trusting the moment: it ties "a review happened" to the
precise bytes being committed, so you cannot fix-after-review and slip unreviewed
code in. The review itself is performed by the *main* agent spawning the
read-only subagent (which is given ONLY a functional brief + the changed-file list, never the
author's reasoning) — this hook only enforces that the checkpoint occurred.

Modes:
  (no arg)   gate    — read the PreToolUse event on stdin, allow/deny the commit.
  approve            — hash the current staged diff and write the stamp (run by
                       the main agent AFTER the subagent review is clean).
  status             — print whether the current staged diff is approved.
  precommit          — native git pre-commit enforcement (runtime-independent
                       second layer); exits non-zero to abort the commit.

A denied commit exits with **code 2** and writes the reason to **stderr** — the
universally-honored Claude Code PreToolUse block contract (the tool call is
blocked and the reason is shown back to the agent). The older stdout JSON
`permissionDecision = "deny"` contract is NOT honored by every runtime, and
relying on it silently let unreviewed commits through. Allow is a silent exit 0.

Escape hatches (allowed without a stamp):
  * `--dry-run`, `-h`/`--help`        — not real commits
  * `[skip-review]` in the message    — merges / mechanical / trivial commits
  * empty stage                       — git will reject it anyway
Auto-staging (`-a` / `--all`) is refused: stage explicitly with `git add` so the
review covers exactly what is committed.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys


def repo_root() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        return os.getcwd()


def stamp_path() -> str:
    return os.path.join(repo_root(), ".claude", ".review-stamp")


def staged_diff() -> str:
    """The unified diff of exactly what an explicit-staging commit will record."""
    try:
        out = subprocess.run(
            ["git", "diff", "--cached", "--no-color"],
            capture_output=True, text=True, cwd=repo_root(),
        )
        return out.stdout
    except OSError:
        return ""


def staged_hash() -> tuple[str, str]:
    diff = staged_diff()
    return hashlib.sha256(diff.encode("utf-8")).hexdigest(), diff


def read_stamp() -> str:
    try:
        with open(stamp_path(), encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def deny(reason: str) -> None:
    # Exit code 2 is the reliable PreToolUse block signal: Claude Code blocks the
    # tool call and feeds stderr back to the agent. Do NOT switch this back to a
    # stdout JSON `permissionDecision` + exit 0 — that contract is not honored by
    # every runtime, which let unreviewed commits slip through.
    print(reason, file=sys.stderr)
    sys.exit(2)


_SHELL_OPS = {"&&", "||", ";", "|", "&"}
_ENV_OR_WRAPPER = ("sudo", "command", "nice", "env")
_GIT_GLOBAL_VALUE_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}


def commit_args(cmd: str) -> "list[str] | None":
    """Args after `commit` for a *real* `git commit` invocation in `cmd`, else None.

    Tokenises the whole command with shlex (so `git commit` text living inside
    quotes, an `echo`, or a heredoc body is NOT mistaken for an invocation),
    splits on shell operators, and only matches a segment whose leading command —
    after env assignments / `sudo` and git global options like `-C <path>` or
    `-c <k=v>` — is `git … commit`. This catches `git commit`, `a && git commit`,
    and `git -C <path> commit`, while ignoring commit-like substrings. Returns None
    (→ allow) when no such segment exists or the command can't be parsed. Does not
    resolve shell aliases (`g`, `hub`, …) — those are out of scope by design.
    """
    try:
        toks = shlex.split(cmd)
    except ValueError:
        return None

    segments: "list[list[str]]" = []
    segment: "list[str]" = []
    for tok in toks:
        if tok in _SHELL_OPS:
            segments.append(segment)
            segment = []
        else:
            segment.append(tok)
    segments.append(segment)

    for seg in segments:
        i = 0
        while i < len(seg) and (
            re.fullmatch(r"[A-Za-z_]\w*=.*", seg[i]) or seg[i] in _ENV_OR_WRAPPER
        ):
            i += 1
        if i >= len(seg) or os.path.basename(seg[i]) != "git":
            continue
        i += 1
        while i < len(seg):
            tok = seg[i]
            if tok in _GIT_GLOBAL_VALUE_OPTS:
                i += 2  # option takes a value
                continue
            if tok.startswith("-"):
                i += 1
                continue
            break
        if i < len(seg) and seg[i] == "commit":
            return seg[i + 1:]
    return None


def uses_auto_stage(args: "list[str]") -> bool:
    for tok in args:
        if tok == "--all":
            return True
        # short flag cluster containing 'a' (e.g. -a, -am, -ma) but not '--amend'
        if re.fullmatch(r"-[a-z]*a[a-z]*", tok):
            return True
    return False


def gate() -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)

    # `or {}` — an explicit `"tool_input": null` yields None, and `None.get(...)`
    # raises; an uncaught error exits 1 = non-blocking on PreToolUse, letting an
    # unreviewed commit through. main() also wraps this to fail closed.
    cmd = (event.get("tool_input") or {}).get("command", "") or ""

    # Only care about real `git commit` invocations — not commit-like text inside
    # an echo / heredoc / unrelated command (see commit_args).
    args = commit_args(cmd)
    if args is None:
        sys.exit(0)
    if "--dry-run" in args or "--help" in args or "-h" in args:
        sys.exit(0)
    if "[skip-review]" in " ".join(args):
        sys.exit(0)
    if uses_auto_stage(args):
        deny(
            "⛔ Pre-commit review gate: refuse `git commit -a/--all`. Stage the "
            "changes explicitly with `git add <paths>` so the blind review covers "
            "exactly what gets committed, then review + approve."
        )

    digest, diff = staged_hash()
    if not diff.strip():
        # Nothing staged — let git produce its own 'nothing to commit' error.
        sys.exit(0)

    if read_stamp() == digest:
        sys.exit(0)  # approved for this exact staged diff

    deny(
        "⛔ Commit blocked by the pre-commit review gate.\n"
        f"The staged diff (sha {digest[:12]}) has not been reviewed.\n\n"
        "Before committing:\n"
        "1. Spawn the `blind-code-reviewer` subagent (Agent tool). Pass it a "
        "one-paragraph functional brief of what the change should do PLUS the "
        "changed-file list (`git diff --cached --name-only`) — never your "
        "reasoning, rationale, or how you made decisions. The reviewer is "
        "shell-less by design and reads the listed files from disk.\n"
        "2. Address every Blocker/Major finding it returns (re-review if you edit "
        "— the stamp invalidates on any staged change).\n"
        "3. Record approval:  python3 .claude/hooks/precommit_review_gate.py approve\n"
        "4. Re-run the commit.\n\n"
        "Merges / mechanical / trivial commits may bypass by putting "
        "[skip-review] in the commit message."
    )


def approve() -> int:
    digest, diff = staged_hash()
    if not diff.strip():
        print("[review-gate] Nothing staged — nothing to approve.")
        return 1
    # The reviewer reads WORKTREE bytes; the stamp hashes the INDEX. Approving
    # while any staged file also has unstaged edits would stamp bytes the
    # reviewer never saw — refuse until the two agree.
    try:
        status_proc = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, cwd=repo_root(),
        )
    except OSError:
        status_proc = None
    if status_proc is None or status_proc.returncode != 0:
        print(
            "[review-gate] REFUSED: could not determine index/worktree divergence "
            "(git status failed) — refusing to stamp rather than guessing."
        )
        return 1
    porcelain = status_proc.stdout
    diverged = [
        line[3:] for line in porcelain.splitlines()
        if len(line) > 3 and line[0] not in (" ", "?") and line[1] not in (" ",)
    ]
    # Staged deletion with the file still on disk ("D " + a sibling "??"): the
    # reviewer reading disk sees a live file while the stamp covers a deletion.
    diverged += [
        line[3:] for line in porcelain.splitlines()
        if len(line) > 3 and line[0] == "D" and line[1] == " "
        and os.path.exists(os.path.join(repo_root(), line[3:]))
    ]
    if diverged:
        print(
            "[review-gate] REFUSED: staged files also have unstaged edits — the "
            "reviewer saw disk state, the stamp would cover index state. Stage or "
            "revert the working-tree edits first: " + ", ".join(diverged[:5])
        )
        return 1
    os.makedirs(os.path.dirname(stamp_path()), exist_ok=True)
    with open(stamp_path(), "w", encoding="utf-8") as fh:
        fh.write(digest + "\n")
    print(
        f"[review-gate] Approved staged diff {digest[:12]} — `git commit` will "
        "pass for this exact diff. Any further staged change requires re-review."
    )
    return 0


def status() -> int:
    digest, diff = staged_hash()
    if not diff.strip():
        print("[review-gate] No staged changes.")
        return 0
    ok = read_stamp() == digest
    print(f"[review-gate] staged {digest[:12]} — {'APPROVED' if ok else 'NOT reviewed'}")
    return 0 if ok else 1


def precommit() -> int:
    """Native git pre-commit enforcement — the runtime-independent second layer.

    Git runs this on every `git commit` regardless of the agent or client, so the
    review gate holds even for commits made outside Claude Code. Blocks (exit 1,
    which aborts the commit) unless the staged diff is approved (stamp matches).
    Bypass a merge / mechanical / trivial commit with `SKIP_REVIEW=1 git commit …`
    (the git pre-commit hook cannot see the message, so the env var is its
    equivalent of the Claude layer's `[skip-review]`).
    """
    # Explicit truthy values only — `SKIP_REVIEW=0` / `false` must NOT bypass.
    if os.environ.get("SKIP_REVIEW", "").strip().lower() in {"1", "true", "yes"}:
        return 0
    digest, diff = staged_hash()
    if not diff.strip():
        return 0  # nothing staged — let git produce its own error
    if read_stamp() == digest:
        return 0
    sys.stderr.write(
        "\n⛔ git pre-commit: blind code review required before this commit.\n"
        f"   Staged diff (sha {digest[:12]}) has not been reviewed/approved.\n"
        "   1. Spawn the blind-code-reviewer on `git diff --cached` (functional brief only).\n"
        "   2. Fix every Blocker/Major finding.\n"
        "   3. python3 .claude/hooks/precommit_review_gate.py approve\n"
        "   4. Re-run the commit.\n"
        "   Bypass a merge/trivial commit with:  SKIP_REVIEW=1 git commit …\n\n"
    )
    return 1


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "approve":
        sys.exit(approve())
    if arg == "status":
        sys.exit(status())
    if arg == "precommit":
        sys.exit(precommit())
    # PreToolUse gate path. Fail CLOSED: if the gate cannot evaluate the event it
    # must block the commit (exit 2), never let a crash become a non-blocking exit 1
    # that admits an unreviewed commit. deny()/allow are SystemExit and pass through.
    try:
        gate()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 — deliberate catch-all for fail-closed
        print(f"⛔ Pre-commit review gate: internal error, blocking commit to fail "
              f"closed: {e!r}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
