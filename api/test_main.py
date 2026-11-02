import unittest

from main import build_agent_prompt, extract_agent_output


class AgentOutputTests(unittest.TestCase):
    def test_extracts_final_text_from_json_envelope(self):
        text, error = extract_agent_output(
            '{"ok":true,"final":"Hi Bye World","payloads":[{"text":"Hi Bye World"}]}'
        )
        self.assertEqual(text, "Hi Bye World")
        self.assertIsNone(error)

    def test_extracts_payload_text_when_final_is_missing(self):
        text, error = extract_agent_output(
            '{"ok":true,"payloads":[{"text":"first"},{"text":"second"}]}'
        )
        self.assertEqual(text, "first\nsecond")
        self.assertIsNone(error)

    def test_reports_structured_agent_error(self):
        text, error = extract_agent_output(
            '{"ok":false,"final":"Task failed","error":{"message":"Node unavailable"}}'
        )
        self.assertEqual(text, "Task failed")
        self.assertEqual(error, "Node unavailable")

    def test_preserves_non_json_stdout(self):
        text, error = extract_agent_output("plain output")
        self.assertEqual(text, "plain output")
        self.assertIsNone(error)


class AgentPromptTests(unittest.TestCase):
    def test_prompt_contains_persistent_execution_rules(self):
        prompt = build_agent_prompt("Run test.py")
        self.assertIn(
            r"C:\Users\Magnus\AppData\Local\Python\pythoncore-3.15-64\python.exe",
            prompt,
        )
        self.assertIn("Do not edit, create", prompt)
        self.assertIn("unless the user's task explicitly asks", prompt)
        self.assertIn("Run test.py", prompt)


if __name__ == "__main__":
    unittest.main()
