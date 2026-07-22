#!/usr/bin/env python3
"""Unit tests for the sync pipeline's trust boundary.

`extract_payload` decides what crosses into another repository's automation, and
its inputs are model output influenced by public PR content — so every refusal
branch is worth pinning. Stdlib only (`python3 -m unittest`): the repo is a Node
package and these scripts are its one bit of Python; a pytest dependency would
cost more than it buys.

Run: python3 -m unittest discover -s .github/scripts -p 'test_*.py'
"""

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

from generate_sync import extract_payload, is_retryable  # noqa: E402


def message(text, stop_reason="end_turn", blocks=None):
    """Minimal stand-in for an SDK response; `blocks` overrides content entirely."""
    if blocks is None:
        blocks = [types.SimpleNamespace(type="text", text=text)]
    return types.SimpleNamespace(stop_reason=stop_reason, content=blocks)


VALID_ENTRY = """
output_type: knowledge_entry
domain: Hobby_AiTriage
knowledge_type: Feature
title: A thing was built
context:
  problem: >
    prose with "quotes", colons: and dashes — freely
"""


class ExtractPayloadAccepts(unittest.TestCase):
    def test_valid_entry_passes_with_parsed_payload(self):
        raw, parsed, error = extract_payload(message(VALID_ENTRY))
        self.assertIsNone(error)
        self.assertEqual(parsed["output_type"], "knowledge_entry")
        self.assertIn("A thing was built", raw)

    def test_noop_needs_no_domain(self):
        raw, parsed, error = extract_payload(
            message("output_type: noop\nreason: formatting only\n")
        )
        self.assertIsNone(error)
        self.assertEqual(parsed["output_type"], "noop")

    def test_markdown_fences_are_stripped(self):
        fenced = "```yaml\n" + VALID_ENTRY.strip() + "\n```"
        raw, _, error = extract_payload(message(fenced))
        self.assertIsNone(error)
        self.assertFalse(raw.startswith("```"))

    def test_knowledge_gaps_is_accepted(self):
        gaps = (
            "output_type: knowledge_gaps\n"
            "domain: Hobby_AiTriage\n"
            "missing_information:\n"
            "  - question: why was this built\n"
            "severity: medium\n"
        )
        _, parsed, error = extract_payload(message(gaps))
        self.assertIsNone(error)
        self.assertEqual(parsed["output_type"], "knowledge_gaps")

    def test_unterminated_fence_uses_the_fallback_branch(self):
        _, _, error = extract_payload(message("```yaml\n" + VALID_ENTRY.strip()))
        self.assertIsNone(error)

    def test_text_block_is_found_after_a_thinking_block(self):
        blocks = [
            types.SimpleNamespace(type="thinking", thinking="pondering"),
            types.SimpleNamespace(type="text", text=VALID_ENTRY),
        ]
        _, _, error = extract_payload(message(None, blocks=blocks))
        self.assertIsNone(error)


class ExtractPayloadRefuses(unittest.TestCase):
    """Every refusal returns no payload; `yaml:`-tagged ones are the retryable set."""

    def assertRefused(self, msg, *, retryable):
        raw, parsed, error = extract_payload(msg)
        self.assertIsNone(raw)
        self.assertIsNone(parsed)
        self.assertIsNotNone(error)
        self.assertEqual(error.startswith("yaml:"), retryable, error)
        return error

    def test_truncated_response_is_refused_and_not_retryable(self):
        # The real failure that motivated the token-ceiling raise.
        self.assertRefused(message(VALID_ENTRY, stop_reason="max_tokens"), retryable=False)

    def test_no_text_block_is_refused(self):
        blocks = [types.SimpleNamespace(type="thinking", thinking="only thinking")]
        self.assertRefused(message(None, blocks=blocks), retryable=False)

    def test_invalid_yaml_is_refused_and_retryable(self):
        # The real failure that motivated the self-correction pass: prose with a
        # quote character inside a plain scalar.
        broken = 'output_type: knowledge_entry\ntitle: he said "hi": then left\n'
        self.assertRefused(message(broken), retryable=True)

    def test_non_mapping_is_refused(self):
        self.assertRefused(message("- just\n- a list\n"), retryable=True)

    def test_unknown_output_type_is_refused(self):
        self.assertRefused(message("output_type: freestyle\n"), retryable=True)

    def test_entry_missing_title_is_refused(self):
        self.assertRefused(
            message("output_type: knowledge_entry\ndomain: Hobby_AiTriage\nknowledge_type: Feature\n"),
            retryable=True,
        )

    def test_entry_missing_knowledge_type_is_refused(self):
        self.assertRefused(
            message("output_type: knowledge_entry\ndomain: Hobby_AiTriage\ntitle: T\n"),
            retryable=True,
        )

    def test_wrong_domain_is_refused_and_not_retryable(self):
        # Misrouting would misfile the entry in someone else's domain; re-asking
        # the model to "try again" is not the remedy.
        wrong = VALID_ENTRY.replace("Hobby_AiTriage", "Some_Other_Domain")
        error = self.assertRefused(message(wrong), retryable=False)
        self.assertIn("Some_Other_Domain", error)

    def test_missing_domain_is_refused_but_retryable(self):
        # An omitted mandatory field is a shape error a re-prompt can fix — unlike
        # a domain MISMATCH above, which is misrouting.
        no_domain = VALID_ENTRY.replace("domain: Hobby_AiTriage\n", "")
        self.assertRefused(message(no_domain), retryable=True)

    def test_empty_text_block_is_refused_and_not_retryable(self):
        # The correction turn echoes prior text back; an empty text block would make
        # that request itself invalid, so this must not be tagged retryable.
        self.assertRefused(message("   \n  "), retryable=False)

    def test_fence_only_output_is_refused(self):
        self.assertRefused(message("```yaml\n```"), retryable=False)


class RetryContract(unittest.TestCase):
    """The helper and the retry loop agree through this one predicate."""

    def test_shape_errors_are_retryable(self):
        self.assertTrue(is_retryable("yaml: output is not a YAML mapping"))

    def test_truncation_and_misrouting_are_not(self):
        self.assertFalse(is_retryable("model stopped with 'max_tokens', not end_turn"))
        self.assertFalse(is_retryable("payload domain 'X' is not Hobby_AiTriage"))
        self.assertFalse(is_retryable("model produced an empty text block"))

    def test_every_refusal_reason_classifies(self):
        # each refusal the helper can emit must land on one side of the predicate
        for msg, expected in [
            (message(VALID_ENTRY, stop_reason="max_tokens"), False),
            (message("   "), False),
            (message("- a list"), True),
            (message(VALID_ENTRY.replace("Hobby_AiTriage", "Other")), False),
        ]:
            _, _, reason = extract_payload(msg)
            self.assertEqual(is_retryable(reason), expected, reason)


if __name__ == "__main__":
    unittest.main()
