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
    """Verify that the bridge forwards exactly the submitted task text."""

    def test_prompt_is_exactly_the_submitted_task(self):
        task = 'Open test.py and print("hi rei")'
        self.assertEqual(build_agent_prompt(task), task)

    def test_prompt_does_not_add_workspace_or_execution_rules(self):
        task = "Run the command I supplied."
        prompt = build_agent_prompt(task)
        self.assertNotIn("Workspace:", prompt)
        self.assertNotIn("EXECUTION AND FILE-CHANGE RULES", prompt)
        self.assertNotIn("Python", prompt)
        self.assertEqual(prompt, task)


if __name__ == "__main__":
    # Also supports direct execution with: python -m unittest -v test_main.py
    unittest.main()
