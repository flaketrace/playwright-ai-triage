#!/usr/bin/env python3
"""
Second-brain sync — delivery step.

Routes the output from generate_sync.py into the second-brain inbox:
  KNOWLEDGE_ENTRY -> second-brain-sync/SYNC_TO_WIKI.md
  KNOWLEDGE_GAPS  -> second-brain-sync/KNOWLEDGE_GAPS.md
  NOOP            -> exit clean, no commit

The Librarian workflow in second-brain detects the push and handles
ingestion. This script never writes directly to Wiki/.
"""

import os
import subprocess
import sys

TMP = os.environ.get("RUNNER_TEMP", "/tmp")

result_flag = open(f"{TMP}/SYNC_RESULT.txt", encoding="utf-8").read().strip()
commit_sha = os.environ.get("COMMIT_SHA", "unknown")[:12]
commit_msg = os.environ.get("COMMIT_MSG", "unknown change")
slug = commit_msg.split("\n")[0][:60].strip()
slug = "".join(c if c.isalnum() or c in "-_ " else "" for c in slug)
slug = slug.replace(" ", "_").strip("_")[:50]


def git(args, **kwargs):
    subprocess.run(["git"] + args, cwd="second-brain", check=True, **kwargs)


def deliver(src_path: str, dest_name: str, label: str) -> None:
    content = open(src_path, encoding="utf-8").read()
    os.makedirs("second-brain/second-brain-sync", exist_ok=True)
    open(f"second-brain/second-brain-sync/{dest_name}", "w", encoding="utf-8").write(content)
    git(["config", "user.email", "sync@flaketrace.com"])
    git(["config", "user.name", "AI Triage Sync Agent"])
    git(["add", f"second-brain-sync/{dest_name}"])
    staged = subprocess.run(
        ["git", "diff", "--cached", "--quiet"], cwd="second-brain"
    ).returncode
    if staged == 0:
        # Identical content already at HEAD (e.g. a backfill re-run) — idempotent no-op.
        print("Inbox already holds identical content — nothing to deliver.")
        return
    git(["commit", "-m", f"sync({label}): ai-triage {commit_sha} — {slug}"])
    # The Librarian (or a sibling repo's sync) may have pushed between our
    # checkout and now — rebase-and-retry once before giving up.
    for attempt in (1, 2):
        push = subprocess.run(["git", "push"], cwd="second-brain")
        if push.returncode == 0:
            break
        if attempt == 1:
            git(["pull", "--rebase"])
        else:
            raise SystemExit("git push failed after rebase retry")
    print(f"Delivered {dest_name} to inbox — Librarian will ingest.")


if result_flag == "KNOWLEDGE_ENTRY":
    deliver(f"{TMP}/SYNC_TO_WIKI.md", "SYNC_TO_WIKI.md", "knowledge-entry")
elif result_flag == "KNOWLEDGE_GAPS":
    deliver(f"{TMP}/KNOWLEDGE_GAPS.md", "KNOWLEDGE_GAPS.md", "knowledge-gaps")
elif result_flag == "NOOP":
    print("NOOP — nothing to deliver.")
    sys.exit(0)
else:
    raise SystemExit(f"unrecognized sync result flag {result_flag!r} — refusing to guess")
