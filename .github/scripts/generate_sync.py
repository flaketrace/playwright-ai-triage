#!/usr/bin/env python3
"""
Second-brain sync — analysis step.

Covers the FULL range of commits in a push (BEFORE_SHA..AFTER_SHA), not just
HEAD~1..HEAD: on fast-forward merges to main this captures every commit that
arrived in the push. A workflow_dispatch run supplies the range explicitly
(backfill lever).

Output types (exactly one):
  KNOWLEDGE_ENTRY  -> $RUNNER_TEMP/SYNC_TO_WIKI.md
  KNOWLEDGE_GAPS   -> $RUNNER_TEMP/KNOWLEDGE_GAPS.md
  NOOP             -> nothing

Result written to $RUNNER_TEMP/SYNC_RESULT.txt for commit_sync.py, and the
result flag is exported via GITHUB_OUTPUT (key `result`) so the workflow can
skip the PAT-bearing delivery steps entirely on NOOP.
"""

import os
import subprocess

import anthropic
import yaml

TMP = os.environ.get("RUNNER_TEMP", "/tmp")

CONTRACT_PATH = ".agentic/guides/second-brain-contract.md"
MODEL = "claude-sonnet-5"

CONTRACT = open(CONTRACT_PATH, encoding="utf-8").read()

SYSTEM_PROMPT = f"""
You are the playwright-ai-triage knowledge-capture agent running inside CI.
Follow the Second Brain Sync Contract below EXACTLY.

{CONTRACT}

CRITICAL OUTPUT RULES:
1. Output ONLY raw YAML — no markdown fences, no commentary, no preamble.
2. First field MUST be: output_type: knowledge_entry | knowledge_gaps | noop
3. Match the schema for that output type exactly, including the mandatory
   `domain: Hobby_AiTriage` field on non-noop outputs.
4. Never invent motivations. Use only git diff and commit messages as sources.
5. A push may contain multiple commits. Treat them as ONE feature cluster per
   the BACKFILL RULE — produce one output, not one per commit.
6. The human-readable name MUST use the exact key `title:` — never any synonym.
"""

DIFF_HARD_CAP = 32_000  # chars sent to the model
FILE_PATCH_CAP = 4_000  # chars per individual file patch


def run(args, **kw) -> str:
    proc = subprocess.run(args, capture_output=True, text=True, **kw)
    if proc.returncode != 0:
        # Fail LOUD: a bad SHA or unreachable range must fail the job, not
        # silently collapse the prompt to an empty diff and ship a NOOP.
        raise SystemExit(f"git {' '.join(args[1:3])} failed: {proc.stderr.strip()[:300]}")
    return proc.stdout


def verify_sha(ref: str) -> str:
    """Resolve to a full commit SHA or die — also neutralizes option-injection
    (a leading-dash dispatch input never reaches git as an option)."""
    return run(["git", "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"]).strip()


def get_range() -> "tuple[str, str]":
    before = os.environ.get("BEFORE_SHA", "").strip()
    after = os.environ.get("AFTER_SHA", "").strip()
    null_sha = "0" * 40
    after = verify_sha(after) if after else verify_sha("HEAD")
    # Null/absent before = first push of a branch — fall back to the parent
    if not before or before == null_sha:
        before = verify_sha(f"{after}~1")
    else:
        before = verify_sha(before)
    return before, after


def get_commit_log(before: str, after: str) -> str:
    return run(
        [
            "git",
            "log",
            f"{before}..{after}",
            "--format=--- %H%n%s%n%b",
            "--no-merges",
        ]
    )


def get_smart_diff(before: str, after: str) -> str:
    # Stat first (always small)
    stat = run(["git", "diff", f"{before}..{after}", "--stat", "--no-color"])

    # Full patch, then trim per file so no single file drowns the others
    full = run(["git", "diff", f"{before}..{after}", "--no-color"])

    if len(full) <= DIFF_HARD_CAP:
        return stat + "\n" + full

    sections = full.split("\ndiff --git ")
    trimmed = [stat, "\n[diff truncated — largest files capped]\n"]
    budget = DIFF_HARD_CAP - len(stat)
    for i, section in enumerate(sections):
        chunk = ("" if i == 0 else "diff --git ") + section
        capped = chunk[:FILE_PATCH_CAP]
        if len(chunk) > FILE_PATCH_CAP:
            capped += f"\n... ({len(chunk) - FILE_PATCH_CAP} chars omitted)\n"
        if budget - len(capped) < 0:
            trimmed.append(f"\n[{len(sections) - i} more files omitted — budget exhausted]\n")
            break
        trimmed.append(capped)
        budget -= len(capped)

    return "".join(trimmed)


def main() -> None:
    before, after = get_range()
    log = get_commit_log(before, after)
    diff = get_smart_diff(before, after)

    n_commits = log.count("--- ")
    print(f"Analysing {n_commits} commit(s) in range {before[:8]}..{after[:8]}")

    client = anthropic.Anthropic()
    message = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": (
                    f"Push range: {before[:12]}..{after[:12]}\n"
                    f"Commits ({n_commits}):\n{log}\n\n"
                    f"Diff:\n{diff}"
                ),
            }
        ],
    )

    if message.stop_reason != "end_turn":
        # A token-capped or otherwise truncated payload must never ship.
        raise SystemExit(f"model stopped with {message.stop_reason!r}, not end_turn — refusing to deliver")

    # Current-generation models may emit thinking blocks before the text block.
    raw = next((b.text for b in message.content if getattr(b, "type", "") == "text"), None)
    if raw is None:
        raise SystemExit("model response contained no text block — refusing to deliver")
    raw = raw.strip()
    # Strip markdown fences if the model included them despite instructions
    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    # Trust boundary: this file is delivered into another repo's automation, and
    # the model's inputs include public PR content. Nothing unvalidated ships.
    try:
        parsed = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        raise SystemExit(f"model output is not valid YAML — refusing to deliver: {exc}")
    if not isinstance(parsed, dict):
        raise SystemExit("model output is not a YAML mapping — refusing to deliver")
    output_type = parsed.get("output_type")
    if output_type not in ("knowledge_entry", "knowledge_gaps", "noop"):
        raise SystemExit(f"invalid output_type {output_type!r} — refusing to deliver")
    if output_type == "knowledge_entry":
        for required in ("title", "knowledge_type"):
            if not parsed.get(required):
                raise SystemExit(f"knowledge_entry missing required field {required!r} — refusing to deliver")
    if output_type != "noop" and parsed.get("domain") != "Hobby_AiTriage":
        raise SystemExit(
            f"payload domain {parsed.get('domain')!r} is not Hobby_AiTriage — "
            "refusing to deliver (misrouting would misfile the entry)"
        )

    if output_type == "knowledge_entry":
        open(f"{TMP}/SYNC_TO_WIKI.md", "w", encoding="utf-8").write(raw)
        result = "KNOWLEDGE_ENTRY"
    elif output_type == "knowledge_gaps":
        open(f"{TMP}/KNOWLEDGE_GAPS.md", "w", encoding="utf-8").write(raw)
        result = "KNOWLEDGE_GAPS"
    else:
        result = "NOOP"
        print(f"NOOP reason: {parsed.get('reason', '')!s:.200}")
    open(f"{TMP}/SYNC_RESULT.txt", "w", encoding="utf-8").write(result)
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as fh:
            fh.write(f"result={result}\n")
    print(f"Output: {result}")


if __name__ == "__main__":
    main()
