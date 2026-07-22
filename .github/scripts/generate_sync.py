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
7. YAML VALIDITY IS MANDATORY. Prose carries colons, quotes and dashes that break
   plain scalars, so write EVERY multi-word prose value as a block scalar:

       problem: >
         text here, which may contain "quotes", colons: and dashes — freely

   Never begin a plain scalar with a quote or bracket character, and never emit a
   bare `key: value` whose value contains a colon-space sequence.
8. Be concise. An entry is a structured summary, not a changelog: a few sentences
   per field. Long diffs do not license long entries.
"""

DIFF_HARD_CAP = 32_000  # chars sent to the model
FILE_PATCH_CAP = 4_000  # chars per individual file patch
# Deliberately a ceiling, not a target. 4096 (inherited from the sibling pipeline)
# truncated a real backfill over a large infrastructure change and the stop_reason
# guard correctly refused to deliver it. Anything that still overruns 8192 is too
# verbose to be a good entry, and failing loudly is the right outcome.
MAX_OUTPUT_TOKENS = 8192


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


def is_retryable(reason: str) -> bool:
    """Whether a refusal reason is one a re-prompt can plausibly fix.

    Parse/shape problems are; truncation, an empty response and misrouting are not
    — re-asking for "the same analysis" would repeat the overrun or the misfiling.
    """
    return reason.startswith("yaml:")


def extract_payload(message) -> "tuple[str | None, dict | None, str | None]":
    """Validate a model response at the trust boundary.

    Returns (raw_yaml, parsed, None) when the payload may ship, or
    (None, None, reason) when it may not. The payload is delivered into another
    repo's automation and the model's inputs include public PR content, so every
    check here is a refusal — never a repair.

    `reason` is prefixed `yaml:` for parse/shape rejections, which are the ones a
    re-prompt can plausibly fix; callers use that to decide whether to retry.
    """
    if message.stop_reason != "end_turn":
        return None, None, f"model stopped with {message.stop_reason!r}, not end_turn"

    # Current-generation models may emit thinking blocks before the text block.
    raw = next((b.text for b in message.content if getattr(b, "type", "") == "text"), None)
    if raw is None:
        return None, None, "model response contained no text block"
    raw = raw.strip()
    # Strip markdown fences if the model included them despite instructions
    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:]).strip()
    if not raw:
        # Not retryable: the correction turn echoes the prior text back, and an
        # empty text block is itself an invalid request — we would trade a clean
        # refusal for an SDK traceback.
        return None, None, "model produced an empty text block"

    try:
        parsed = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        return None, None, f"yaml: output is not valid YAML: {str(exc)[:300]}"
    if not isinstance(parsed, dict):
        return None, None, "yaml: output is not a YAML mapping"
    output_type = parsed.get("output_type")
    if output_type not in ("knowledge_entry", "knowledge_gaps", "noop"):
        return None, None, f"yaml: invalid output_type {str(output_type)[:80]!r}"
    if output_type == "knowledge_entry":
        for required in ("title", "knowledge_type"):
            if not parsed.get(required):
                return None, None, f"yaml: knowledge_entry missing required field {required!r}"
    if output_type != "noop":
        domain = parsed.get("domain")
        if not domain:
            # A forgotten mandatory field is the same class as a missing title —
            # a re-prompt fixes it.
            return None, None, "yaml: payload is missing the mandatory domain field"
        if domain != "Hobby_AiTriage":
            # A DIFFERENT domain is misrouting, not an omission: re-asking the model
            # to try again is not the remedy for filing into someone else's space.
            return None, None, (
                f"payload domain {str(domain)[:80]!r} is not Hobby_AiTriage "
                "(misrouting would misfile the entry)"
            )
    return raw, parsed, None


def main() -> None:
    before, after = get_range()
    log = get_commit_log(before, after)
    diff = get_smart_diff(before, after)

    n_commits = log.count("--- ")
    print(f"Analysing {n_commits} commit(s) in range {before[:8]}..{after[:8]}")

    # Imported here, not at module scope: the trust-boundary helper below is pure
    # and its tests must not require the SDK to be installed.
    import anthropic

    client = anthropic.Anthropic()
    conversation = [
        {
            "role": "user",
            "content": (
                f"Push range: {before[:12]}..{after[:12]}\n"
                f"Commits ({n_commits}):\n{log}\n\n"
                f"Diff:\n{diff}"
            ),
        }
    ]

    # One bounded self-correction pass, for parse/shape rejections only: those are
    # what a re-prompt can plausibly fix. A truncation or a routing refusal gets no
    # retry — re-asking for "the same analysis" would just overrun or misroute again.
    for attempt in (1, 2):
        message = client.messages.create(
            model=MODEL,
            max_tokens=MAX_OUTPUT_TOKENS,
            system=SYSTEM_PROMPT,
            messages=conversation,
        )
        raw, parsed, error = extract_payload(message)
        if error is None:
            break
        if attempt == 2 or not is_retryable(error):
            suffix = " (after one correction attempt)" if attempt == 2 else ""
            raise SystemExit(f"{error}{suffix} — refusing to deliver")
        print(f"Attempt {attempt} rejected: {error} — asking the model to correct it")
        # Echo back a plain text block, never the raw SDK blocks: a thinking or
        # empty content array would make the correction request itself invalid.
        prior = next((b.text for b in message.content if getattr(b, "type", "") == "text"), "")
        conversation += [
            {"role": "assistant", "content": [{"type": "text", "text": prior}]},
            {
                "role": "user",
                "content": (
                    f"That output was rejected: {error}\n"
                    "Re-emit the SAME analysis as valid YAML. Put every prose value in "
                    "a block scalar (`>`), and return raw YAML only — no fences, no "
                    "commentary."
                ),
            },
        ]

    output_type = parsed["output_type"]

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
