# OpenClaw ChatGPT Bridge

A local-first bridge that lets a user arm automatic, explicitly marked task handoffs from ChatGPT to OpenClaw running on Windows, then returns execution reports to the same conversation.

> Status: early implementation (v0.3). The extension popup contains the Run/Stop controls; no controls are injected into the ChatGPT page. Automation is stopped by default and only assistant messages containing the explicit `[[OPENCLAW_TASK]] ... [[/OPENCLAW_TASK]]` block are eligible for execution.

## Intended workflow

1. ChatGPT helps prepare a task.
2. You explicitly send that task using the browser extension.
3. The local FastAPI service creates a task ID and invokes the Gateway-backed OpenClaw agent CLI.
4. OpenClaw runs the task in the configured project workspace.
5. The extension retrieves the task result using its task ID.
6. You review the result and bring it back to ChatGPT. ChatGPT decides the next step; nothing runs automatically without another handoff.

The extension is a manual relay, **not a native ChatGPT tool**. It does not silently read the conversation or automatically execute assistant messages.

## Components

- **OpenClaw**: existing Windows agent and execution environment.
- **FastAPI**: authenticated loopback API and SQLite task ledger.
- **n8n**: local workflow orchestration UI (Docker Compose deployment).
- **Browser extension**: manual task submission from a ChatGPT tab.

## Repository layout

```text
.
├── api/
│   ├── main.py
│   ├── requirements.txt
│   └── .env.example
├── extension/
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.js
│   └── content.js
├── compose.yaml
├── .env.example
└── README.md
```

## Prerequisites

- Windows 10/11
- Docker Desktop with the WSL 2 backend
- Python 3.10+
- OpenClaw CLI installed and working for the Windows user running the API
- Chrome or a Chromium-based browser

## Local setup

### 1. Configure n8n

Copy `.env.example` to `.env`. Generate a unique encryption key and keep it private. In PowerShell:

```powershell
Copy-Item .env.example .env
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$key = [Convert]::ToBase64String($bytes)
(Get-Content .env -Raw).Replace('replace-with-a-random-32-byte-or-longer-secret', $key) | Set-Content .env
```

Start n8n:

```powershell
docker compose up -d
```

Open [http://localhost:5678](http://localhost:5678) and complete the initial owner setup. n8n data is stored in the named Docker volume `openclaw-chatgpt-bridge-n8n-data`.

### 2. Configure the local API

Copy `api/.env.example` to `api/.env`. Set a long random `BRIDGE_API_TOKEN` and set `OPENCLAW_WORKSPACE` to the project folder you intend to operate on. The template uses Node plus the OpenClaw `.mjs` entrypoint path from the current Windows installation; update `OPENCLAW_ENTRYPOINT` if your installed package path differs. `OPENCLAW_PYTHON` is injected into every task prompt so the agent uses the configured full interpreter path instead of relying on Windows PATH aliases. This setting controls Python used by the OpenClaw agent, not the Python interpreter used to run the FastAPI service.

Install and run:

```powershell
py -m venv api/.venv
api/.venv/Scripts/python.exe -m pip install -r api/requirements.txt
api/.venv/Scripts/python.exe -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8765
```

Check [http://127.0.0.1:8765/health](http://127.0.0.1:8765/health).

The API intentionally binds to loopback. Do not change it to `0.0.0.0` or expose it publicly without a separately reviewed network security design.

### 3. Run the bridge from VS Code

Open the repository in VS Code and start the local FastAPI bridge from the integrated PowerShell terminal:

```powershell
cd C:\Magnus\Code\OpenClaw-ChatGPT-Bridge
.venv\Scripts\python.exe -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8765
```

Keep this terminal running while using the browser extension. The bridge should be available at `http://127.0.0.1:8765`.

To verify that the bridge is running, open another VS Code terminal and run:

```powershell
curl http://127.0.0.1:8765/health
```

Expected response:

```json
{"status":"ok","service":"openclaw-chatgpt-bridge-api"}
```

This starts the local FastAPI bridge; it does not start the OpenClaw Gateway itself.

### 4. Load the extension

1. Open `chrome://extensions` (or your Chromium browser's equivalent).
2. Enable Developer mode.
3. Choose **Load unpacked** and select this repository's `extension` folder.
4. Open ChatGPT and click the extension icon.
5. Enter the local API token and a task, then submit.

When armed, the content script watches only assistant messages for the explicit task markers. It ignores ordinary messages and never scans old conversation content when Run is pressed.

## API

All task endpoints except health require:

```http
Authorization: Bearer <BRIDGE_API_TOKEN>
```

- `GET /health` — liveness check.
- `POST /v1/tasks` — submit a task; returns `202` and a task ID.
- `GET /v1/tasks/{task_id}` — inspect status and execution result.

Example request:

```json
{ "task": "Run test.py and report stdout, stderr, and exit code." }
```

A task result includes `status`, `stdout`, `stderr`, `exit_code`, timestamps, and an error field when applicable.

## Current milestones

- [x] Initial private repository and project scaffold
- [x] Local n8n Compose deployment definition
- [x] Authenticated FastAPI task API with SQLite task tracking
- [x] Manual extension popup for task submission
- [x] Use the supported Gateway-backed `openclaw agent --message-file --json` invocation and parse its final reply
- [x] Inject the user's Python full-path and execution-only/file-change instructions into every handed-off task
- [x] Add result polling and a copy/return-to-ChatGPT action in the extension
- [ ] Add an importable n8n workflow and wire n8n into the task lifecycle
- [x] Add initial unit tests for JSON result parsing and persistent task instructions
- [ ] Run the test suite on the user's Windows installation and add a one-command local launcher
- [ ] Add explicit per-task file-diff reporting

## Security notes

- Keep `.env`, `api/.env`, tokens, encryption keys, SQLite databases, and execution logs out of Git.
- Keep the API on `127.0.0.1`.
- The API passes natural-language tasks to the configured OpenClaw agent through the Gateway-backed CLI and captures its structured JSON result. Every task prompt carries the configured Python interpreter path and instructs the agent not to create or modify files unless the task explicitly requests it. OpenClaw's own tool permissions remain authoritative; this project does not attempt to bypass them.
- The configured workspace path is included in the agent instruction, but this is not an OS-level filesystem sandbox. Keep OpenClaw's actual filesystem permissions narrow.
- Do not send secrets or credentials in task text.
- Do not expose n8n or the bridge API to the public internet as part of this local-only setup.

## Detailed code reference

See [BRIDGE_REFERENCE.md](BRIDGE_REFERENCE.md) for the complete feature inventory, every file's purpose, inputs and outputs, the function/class inventory, API contracts, task lifecycle, security boundaries and known gaps.

## Documentation

- [n8n self-hosting](https://docs.n8n.io/deploy/)
- [n8n Docker Compose](https://docs.n8n.io/hosting/installation/server-setups/docker-compose/)
- [OpenClaw agent CLI](https://docs.openclaw.ai/cli/agent)
