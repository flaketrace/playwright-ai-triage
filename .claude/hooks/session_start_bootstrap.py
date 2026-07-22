#!/usr/bin/env python3
# Claude Code SessionStart hook — git-sync + worktree bootstrap context.
#
# Fetches origin and REPORTS drift vs origin/main (never merges — this runs on
# contributor machines too), then adds worktree-specific nudges — including a
# staleness note when the tracked .agentic/ contract tree is absent or shadowed
# by a legacy symlink — plus: missing .env* files, a warning when
# main is already checked out by another worktree (the
# "'branch' is already used by worktree at ..." trap), and the results of the
# configured environment checks (ENV_CHECK_COMMANDS below).
#
# The nudges only *inform* — this hook never copies secrets or installs
# dependencies; those stay explicit actions for the agent/user to run, since a
# fresh worktree bootstrap should be visible, not silent.
#
# stdin (SessionStart event): {"session_id", "transcript_path", "cwd", ...}
# stdout: {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
# exit: 0 always — never blocks session creation.

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

DEFAULT_BRANCH = "main"
# One shell command per line; each is run at session start and reported as a
# bootstrap note when it exits non-zero (stdout/stderr trimmed to one line).
ENV_CHECK_COMMANDS = """node --version\nnpm ls --depth=0"""

REPO_ROOT = Path(__file__).resolve().parents[2]
GIT_TIMEOUT = 30


def run_git(*args: str) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return 1, str(exc)
    return proc.returncode, (proc.stdout or proc.stderr or "").strip()


def git_sync_notes() -> list[str]:
    """Fetch origin and REPORT drift vs origin/DEFAULT_BRANCH — never merge.

    This hook ships in a public repo and runs on every contributor's SessionStart.
    An auto-merge here would silently create merge commits on branches this hook
    does not own — the one thing the header promises the nudges never do. The
    maintainer integrates with one command when the note says so."""
    notes: list[str] = []
    code, _ = run_git("rev-parse", "--is-inside-work-tree")
    if code != 0:
        return notes

    code, out = run_git("fetch", "origin")
    notes.append(f"[git-sync] git fetch origin — {'ok' if code == 0 else 'FAILED: ' + out}")
    if code != 0:
        return notes

    code, branch = run_git("rev-parse", "--abbrev-ref", "HEAD")
    if code != 0 or branch == "HEAD":
        return notes  # detached HEAD — leave it alone

    code, counts = run_git(
        "rev-list", "--left-right", "--count", f"HEAD...origin/{DEFAULT_BRANCH}"
    )
    if code != 0:
        return notes
    ahead, behind = (counts.split() + ["0", "0"])[:2]
    if behind != "0":
        notes.append(
            f"[git-sync] `{branch}` is {behind} commit(s) behind origin/{DEFAULT_BRANCH} "
            f"(and {ahead} ahead) — integrate when ready: "
            f"git merge origin/{DEFAULT_BRANCH}"
        )
    return notes


def env_check_notes() -> list[str]:
    notes: list[str] = []
    for cmd in (line.strip() for line in ENV_CHECK_COMMANDS.splitlines()):
        if not cmd or cmd.startswith("#"):
            continue
        try:
            proc = subprocess.run(
                cmd, shell=True, cwd=REPO_ROOT,
                capture_output=True, text=True, timeout=GIT_TIMEOUT,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            notes.append(f"[bootstrap] env check `{cmd}` errored: {exc}")
            continue
        if proc.returncode != 0:
            detail = (proc.stdout or proc.stderr or "").strip().splitlines()
            notes.append(
                f"[bootstrap] env check `{cmd}` failed (exit {proc.returncode})"
                + (f": {detail[0]}" if detail else "")
            )
    return notes


def agentic_contracts_note() -> list[str]:
    """Sanity note when the tracked `.agentic/` contract tree is absent.

    History: `.agentic/` used to be gitignored, so worktrees silently ran subagents
    on fallback rules — this hook symlinked it from the main checkout as a stopgap.
    The tree is TRACKED now (single source of truth via git), so its absence can
    only mean a stale checkout predating that change or a stray stale symlink; the
    fix is a pull, not a link. Report loudly, never link.
    """
    here = REPO_ROOT / ".agentic"
    if here.is_symlink():
        return [
            f"[bootstrap] {here} is a legacy SYMLINK from the pre-tracked era — remove "
            "it and `git checkout -- .agentic` so the tracked contracts take over."
        ]
    if not here.is_dir():
        return [
            "[bootstrap] .agentic/ contract tree missing — this checkout predates it "
            "being tracked. `git pull` (or merge origin/main); subagents fall back to "
            "inlined rules until then."
        ]
    return []


def worktree_notes() -> list[str]:
    notes: list[str] = []

    code, git_dir = run_git("rev-parse", "--git-dir")
    if code != 0:
        return notes
    code, common_dir = run_git("rev-parse", "--git-common-dir")
    if code != 0:
        return notes

    is_worktree = Path(git_dir).resolve() != Path(common_dir).resolve()
    if not is_worktree:
        return notes

    notes.append("[bootstrap] This session is in a git worktree.")

    main_root = Path(common_dir).resolve().parent
    notes.extend(agentic_contracts_note())

    for env_file in (".env", ".env.local"):
        here = REPO_ROOT / env_file
        there = main_root / env_file
        if not here.exists() and there.exists():
            notes.append(
                f"[bootstrap] {env_file} missing here but present at {there} — "
                f"copy explicitly if needed: cp \"{there}\" \"{here}\""
            )

    code, wt_list = run_git("worktree", "list", "--porcelain")
    if code == 0:
        holders: dict[str, str] = {}
        current_path = ""
        for line in wt_list.splitlines():
            if line.startswith("worktree "):
                current_path = line[len("worktree "):].strip()
            elif line.startswith("branch "):
                branch = line[len("branch "):].strip()
                if branch.startswith("refs/heads/"):
                    holders[branch[len("refs/heads/"):]] = current_path
        holder = holders.get(DEFAULT_BRANCH)
        if holder and Path(holder).resolve() != REPO_ROOT.resolve():
            notes.append(
                f"[bootstrap] `{DEFAULT_BRANCH}` is checked out by another worktree ({holder}) — "
                f"don't `git checkout {DEFAULT_BRANCH}` here, it will fail. Use "
                f"`git fetch origin {DEFAULT_BRANCH} && git merge origin/{DEFAULT_BRANCH}` instead."
            )

    return notes


def main() -> None:
    try:
        sys.stdin.read()
    except OSError:
        pass

    parts = git_sync_notes() + worktree_notes() + env_check_notes()
    context = "\n".join(p for p in parts if p).strip()

    if context:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context,
            }
        }))
    sys.exit(0)


if __name__ == "__main__":
    main()
