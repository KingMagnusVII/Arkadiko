# Unit tests for the pure prompt-building and OpenClaw JSON-output parsing helpers.
# These tests do not start FastAPI, create task rows, or launch an OpenClaw subprocess.

import unittest

from main import build_agent_prompt, extract_agent_output


class AgentOutputTests(unittest.TestCase):
    """Verify that the CLI output parser supports the response shapes we expect."""

    def test_extracts_final_text_from_json_envelope(self):
        # The explicit final field takes priority over the payload list.
        text, error = extract_agent_output(
            '{"ok":true,"final":"Hi Bye World","payloads":[{"text":"Hi Bye World"}]}'
        )
        self.assertEqual(text, "Hi Bye World")
        self.assertIsNone(error)

    def test_extracts_payload_text_when_final_is_missing(self):
        # If final is absent, individual payload text entries are joined in order.
        text, error = extract_agent_output(
            '{"ok":true,"payloads":[{"text":"first"},{"text":"second"}]}'
        )
        self.assertEqual(text, "first\nsecond")
        self.assertIsNone(error)

    def test_reports_structured_agent_error(self):
        # The parser should preserve the error message returned by the agent.
        text, error = extract_agent_output(
            '{"ok":false,"final":"Task failed","error":{"message":"Node unavailable"}}'
        )
        self.assertEqual(text, "Task failed")
        self.assertEqual(error, "Node unavailable")

    def test_preserves_non_json_stdout(self):
        # Plain output remains valid when the CLI does not return a JSON envelope.
        text, error = extract_agent_output("plain output")
        self.assertEqual(text, "plain output")
        self.assertIsNone(error)


class AgentPromptTests(unittest.TestCase):
    """Verify that every task prompt includes the user's persistent execution rules."""

    def test_prompt_contains_persistent_execution_rules(self):
        # Build a sample prompt and check the interpreter path and no-edit-by-default rule.
        prompt = build_agent_prompt("Run test.py")
        self.assertIn(
            r"C:\Users\Magnus\AppData\Local\Python\pythoncore-3.15-64\python.exe",
            prompt,
        )
        self.assertIn("Do not edit, create", prompt)
        self.assertIn("unless the user's task explicitly asks", prompt)
        self.assertIn("Run test.py", prompt)


if __name__ == "__main__":
    # Also supports direct execution with: python -m unittest -v test_main.py
    unittest.main()
