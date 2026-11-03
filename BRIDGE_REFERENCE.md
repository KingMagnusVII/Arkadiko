# OpenClaw ChatGPT Bridge — Complete Code and File Reference

This document describes the execution-loop branch. It documents source behavior; it does not claim the whole project has been integration-tested on the user's Windows PC.

## 1. Architecture

ChatGPT assistant message containing <OpenClaw>...</OpenClaw> -> content script extracts only the tag body -> POST /v1/tasks -> FastAPI -> OpenClaw agent CLI -> captured result -> SQLite -> extension polls -> report is submitted to the originating ChatGPT conversation.

The extension is an explicitly armed relay, not a native ChatGPT tool. It watches new assistant turns for complete <OpenClaw>...</OpenClaw> blocks, forwards only the text inside the tags, polls for completion, and submits the report to the originating ChatGPT conversation. n8n is an optional local service scaffold and is not called by the current FastAPI task lifecycle.

The configured working directory is not an OS-level sandbox. The bridge forwards task text unchanged and does not add repository-generated task instructions. OpenClaw's actual Windows permissions remain the security boundary. The bridge does not configure OpenClaw, pair nodes, change approval policies, or install software.

## 2. Implemented features

1. Manual task handoff from extension popup.
2. Bearer-token authentication for task endpoints.
3. Pydantic request validation; task field length 1–12,000 characters.
4. UUID task IDs.
5. SQLite task ledger with status, timestamps, stdout, stderr, exit code and error.
6. Background asyncio execution; POST returns HTTP 202 quickly.
7. OpenClaw CLI invocation with agent ID, temporary prompt file, timeout and JSON output.
8. Persistent Python 3.15 full-path instruction injected into every agent prompt.
9. Instruction not to use bare python/python3/py.
10. Default read/execute/report workflow; no file edits unless explicitly requested.
11. Workspace and privacy boundaries included in agent prompt.
12. JSON result parsing with plain-text fallback.
13. Subprocess timeout handling and temporary prompt cleanup.
14. Unauthenticated liveness endpoint.
15. Manual result polling by task ID.
16. Copy formatted result to clipboard for deliberate paste into ChatGPT.
17. Optional n8n Compose service with loopback binding, named volume and health check.
18. Initial unit tests for prompt content and output parsing.

## 3. Repository layout

    .gitignore
    .env.example
    compose.yaml
    README.md
    BRIDGE_REFERENCE.md
    api/main.py
    api/requirements.txt
    api/.env.example
    api/test_main.py
    extension/manifest.json
    extension/popup.html
    extension/popup.js
    extension/content.js

## 4. Every file: purpose, inputs and outputs

### .gitignore
Purpose: tells Git which local/generated files should not be committed.
Inputs: repository paths matched against patterns.
Outputs: no runtime output; matching files are excluded from normal untracked-file reporting.
Patterns ignore .env files except .env.example, keys/certificates, SQLite/database files, Python cache/bytecode, virtual environments, coverage output, node_modules and OS junk.

### Root .env.example
Purpose: starter environment template with optional n8n settings and older/general bridge defaults.
Inputs: user copies it to local .env and replaces placeholders.
Outputs: environment variables for processes that load this file.
Variables: N8N_ENCRYPTION_KEY, N8N_BASIC_AUTH_ACTIVE, GENERIC_TIMEZONE, TZ, BRIDGE_HOST, BRIDGE_PORT, BRIDGE_API_TOKEN, OPENCLAW_COMMAND, OPENCLAW_AGENT_ID, OPENCLAW_WORKSPACE and OPENCLAW_TIMEOUT_SECONDS.
Important: use api/.env.example for current API-specific CLI settings. The bridge does not inject Python or other task instructions. Never commit real .env secrets.

### compose.yaml
Purpose: defines optional n8n Docker service.
Inputs: Docker Compose reads YAML and interpolates timezone and required N8N_ENCRYPTION_KEY values from shell/root .env.
Outputs/effects: starts openclaw-bridge-n8n; maps 127.0.0.1:5678 to container port 5678; persists state in Docker volume openclaw-chatgpt-bridge-n8n-data; checks /healthz.
Not connected: api/main.py does not call n8n. Starting this service does not start FastAPI or OpenClaw.

### README.md
Purpose: short overview, setup guide, API route summary, milestones and security reminders.
Inputs: human reader. Outputs: documentation only.

### BRIDGE_REFERENCE.md
Purpose: this detailed architecture, file I/O, function, endpoint, configuration and limitation reference.
Inputs: repository source files and configuration templates. Outputs: documentation only.

### api/requirements.txt
Purpose: Python package dependency list for FastAPI service.
Input: pip install -r api/requirements.txt.
Outputs: installs FastAPI (API framework), uvicorn[standard] (ASGI server), Pydantic (request validation/data models), python-dotenv (loads local environment files).
These dependency ranges do not pin the Python interpreter used by OpenClaw to run DSA scripts.

### api/.env.example
Purpose: API-specific configuration template. Copy to api/.env, set a strong BRIDGE_API_TOKEN, and verify local Windows paths.
Variables read by api/main.py:
- BRIDGE_API_TOKEN: required Bearer token; empty/placeholder causes protected routes to return HTTP 503.
- OPENCLAW_COMMAND: executable used to start CLI; currently node.
- OPENCLAW_ENTRYPOINT: optional OpenClaw .mjs entrypoint, inserted after Node executable when non-empty.
- OPENCLAW_AGENT_ID: agent passed to openclaw agent --agent.
- OPENCLAW_WORKSPACE: subprocess working directory and working directory for the subprocess.
- 
- OPENCLAW_TIMEOUT_SECONDS: CLI timeout; code enforces minimum 10 seconds.
Template-only currently: BRIDGE_HOST and BRIDGE_PORT are present, but main.py does not read them. The README Uvicorn command supplies host/port explicitly.
Outputs: configuration values read when main.py imports.

### api/main.py
Purpose: main FastAPI application and task execution coordinator.
Inputs: environment values from api/.env and root .env; HTTP requests; OpenClaw CLI JSON stdout/stderr/exit code; configured workspace and temporary prompt file; SQLite database api/bridge.sqlite3 by default or BRIDGE_DB_PATH.
Outputs: HTTP JSON responses; SQLite task rows; temporary prompt passed to OpenClaw then deleted; captured stdout/stderr/exit code/status/timestamps/error stored in SQLite.
Configuration constants: BASE_DIR (source directory), TOKEN (API Bearer token), OPENCLAW_COMMAND/ENTRYPOINT/AGENT_ID (CLI settings), WORKSPACE (resolved working directory), TIMEOUT (minimum 10 seconds), DB_PATH (SQLite location).

Function/class inventory:
- TaskRequest: input JSON with task string; output validated model; length 1–12,000 characters.
- utc_now(): no input; returns current UTC ISO-8601 timestamp.
- connect_db(): no input; opens SQLite, creates tasks table if absent, returns connection.
- db_connection(): context manager; yields connection, commits on success, rolls back on exception, always closes.
- require_token(authorization): HTTP Authorization header; returns no value when valid, raises HTTP 503 if token unconfigured or HTTP 401 if missing/invalid.
- task_record(row): SQLite row input; returns JSON-serializable dictionary.
- build_agent_prompt(task): user task string input; returns the task unchanged, without adding repository instructions.
- extract_agent_output(raw_stdout): raw CLI stdout input; returns (final_text, error_text_or_none), parsing JSON envelope or preserving plain text.
- run_openclaw(task_id, task): UUID and task input; async side effects launch CLI, update SQLite, handle timeout/errors and delete temporary prompt.
- startup(): FastAPI startup event; ensures task table exists.
- health(): GET /health; returns liveness JSON and does not verify OpenClaw connectivity.
- submit_task(body): authenticated POST body; trims task, inserts queued row, starts background coroutine, returns HTTP 202 with task ID/status.
- get_task(task_id): authenticated UUID path parameter; returns stored task record or HTTP 404.

SQLite tasks columns: task_id (UUID primary key), task (trimmed task text), status (queued/running/completed/failed), created_at/started_at/completed_at (UTC timestamps), stdout, stderr, exit_code and error.

Subprocess command when OPENCLAW_ENTRYPOINT is set:
    node <OPENCLAW_ENTRYPOINT> agent --agent <AGENT_ID> --message-file <TEMP_PROMPT> --timeout <SECONDS> --json
When entrypoint is empty, OPENCLAW_COMMAND must itself accept the agent subcommand.

HTTP API contract:
- GET /health: no body/token; returns service liveness JSON.
- POST /v1/tasks: Authorization: Bearer token; JSON {"task":"Run test.py and report output"}; returns HTTP 202 and {"task_id":"<uuid>","status":"queued"}.
- GET /v1/tasks/{task_id}: same Bearer header; returns task, status, timestamps, stdout, stderr, exit_code and error.

### api/test_main.py
Purpose: unit tests for exact task pass-through and JSON output parsing.
Inputs: fixed JSON/plain-text samples and default prompt configuration imported from main.py.
Outputs: unittest pass/fail results; does not start API server or OpenClaw process.
Test methods:
- test_extracts_final_text_from_json_envelope: selects final string from JSON envelope.
- test_extracts_payload_text_when_final_is_missing: joins payload text parts with newline.
- test_reports_structured_agent_error: returns structured error message.
- test_preserves_non_json_stdout: preserves plain stdout.
- test_prompt_is_exactly_the_submitted_task: verifies the submitted text is unchanged.\n- test_prompt_does_not_add_workspace_or_execution_rules: verifies no repository-generated instructions are appended.
Run from api directory: python -m unittest -v test_main.py. This uses API development Python and is separate from the interpreter OpenClaw is instructed to use for DSA scripts.

### extension/manifest.json
Purpose: Chrome Manifest V3 metadata and permissions.
Inputs: Chrome reads JSON when loading unpacked extension.
Outputs/effects: registers popup.html as toolbar popup; grants storage and clipboardWrite permissions; grants host access to ChatGPT and http://127.0.0.1:8765.
JSON does not support comments; explanation is kept here to avoid invalid JSON.
Current behavior: content.js is not registered as a content script. No code is injected into ChatGPT pages.

### extension/popup.html
Purpose: popup structure and styling.
Inputs: browser opens popup; popup.js selects controls by IDs.
Elements: #endpoint (API base URL, default http://127.0.0.1:8765); #token (password input); #task (task text); #send (explicit submit); #check (manual poll, disabled until task accepted); #status (accessible status); #result (hidden report); #copy (copy report).
Outputs: visible popup UI. This file does not make API calls itself.

### extension/popup.js
Purpose: save settings, submit tasks, poll results and copy report.
Inputs: endpoint/token/task entered by user; values restored from chrome.storage.local; JSON responses from FastAPI.
Outputs/effects: saves endpoint/token; POSTs /v1/tasks; stores latest task ID in popup memory; GETs /v1/tasks/{task_id} on user click; updates UI; copies report with navigator.clipboard.writeText.
Function/handler inventory:
- storage restore callback: saved Chrome storage object input; sets endpoint/token fields if present.
- authHeaders(): current token field input; returns JSON and Bearer headers or throws if token empty.
- renderReport(data): completed/failed task JSON input; builds report string, fills result area and reveals Copy button.
- Send click handler: click plus form values; validates task, saves settings, sends POST, stores returned task ID and enables Check.
- Check click handler: click plus in-memory task ID; sends GET, updates status and renders terminal report.
- Copy click handler: click plus latest report; copies report and updates status or shows clipboard error.
Limitations: latest task ID/report are JS variables and reset when popup closes. Endpoint/token persist in extension storage. Polling is manual.

### extension/content.js
Purpose: placeholder for future content-script integration.
Inputs: if registered in manifest later, Chrome would execute it on matching pages. Currently it is not registered.
Outputs/effects: when executed, sets window.__openClawBridgeLoaded = true once and exits. It does not read page text, send requests, add UI or execute tasks.

## 5. Task status lifecycle
POST accepted -> queued -> running -> completed; failures/timeouts/exceptions lead to failed.
Status is completed when subprocess return code is zero and parsed agent JSON has no error. Otherwise it is failed. Tasks remain queryable in SQLite.

## 6. Security and trust model
- API should remain loopback-only as in documented Uvicorn command.
- Protected endpoints compare Bearer token using constant-time comparison.
- Keep real tokens and n8n encryption key in ignored local .env files.
- Extension stores endpoint/token in Chrome extension local storage; anyone with access to same browser profile may be able to use stored token.
- Task text is untrusted. Prompt boundaries are not a hardened sandbox.
- Subprocess runs with Windows account permissions of process hosting FastAPI/OpenClaw.
- No OS-level workspace isolation, file-diff enforcement, rate limiting, task cancellation, automatic polling or production deployment model yet.
- Do not expose API or n8n UI to public internet.

## 7. Known gaps
1. n8n integration: Compose only; no workflow JSON or API-to-n8n call.
2. In-page ChatGPT handoff: manual popup entry; no content-script integration.
3. Automatic polling: user clicks Check latest result.
4. Persistent latest task ID: popup memory resets on close.
5. File change report: prompt asks agent to report changes, but API does not independently snapshot/verify workspace.
6. OS sandbox: workspace is prompt/working-directory constraint, not filesystem isolation.
7. Integration tests: current tests do not launch mocked OpenClaw or exercise HTTP endpoints.
8. Runtime verification: this documentation update has not run the project on user's Windows machine.

## 8. Suggested verification
1. Copy api/.env.example to api/.env; set a strong token and verify OpenClaw paths.
2. Install API dependencies in a virtual environment.
3. Run unit tests from api.
4. Start Uvicorn on 127.0.0.1:8765.
5. Open /health.
6. Load extension/ as unpacked extension.
7. Submit a harmless task that prints a known value; do not request file changes.
8. Click Check latest result until terminal state; compare with actual OpenClaw response.
9. Copy report and paste into ChatGPT.

---
Keep this reference synchronized whenever source files change. This document distinguishes implemented behavior from placeholders and future work.