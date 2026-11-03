# Arkadiko — ChatGPT ↔ OpenClaw Local Bridge

Arkadiko is a local-first bridge that lets you explicitly hand a task from ChatGPT to OpenClaw running on your Windows PC, then return the execution report to the same ChatGPT conversation.

> **Current status:** early implementation (v0.3). The browser extension is user-armed: it is closed by default and only forwards complete `<OpenClaw>...</OpenClaw>` blocks from new assistant messages while the bridge is open. The extension does not inject controls into the ChatGPT page.

## What it does

1. Ask ChatGPT to prepare a task.
2. Open the Arkadiko browser-extension popup and choose **Open Bridge**.
3. ChatGPT sends the text inside a complete `<OpenClaw>...</OpenClaw>` block to the local FastAPI API.
4. The API records the task and invokes your configured OpenClaw agent through the Gateway-backed CLI.
5. The extension polls for the result and submits the report to the originating ChatGPT conversation.
6. Review the result before deciding what to do next. Each new task requires a new explicit handoff.

Arkadiko is an explicitly armed relay, **not a native ChatGPT tool**. Ordinary assistant messages are ignored. Messages that existed before the bridge was opened are also ignored.

## Architecture

```text
ChatGPT assistant response
  └─ <OpenClaw>task text</OpenClaw>
       └─ Browser extension (content.js)
            └─ Extension service worker (background.js)
                 └─ FastAPI API (127.0.0.1:8765)
                      ├─ SQLite task ledger
                      └─ OpenClaw agent CLI
                           └─ Windows workspace / tools
                 └─ Poll result and return report to ChatGPT
```

### Components

- **OpenClaw:** the existing Windows agent and execution environment.
- **FastAPI:** authenticated loopback API and SQLite task ledger.
- **Browser extension:** user-armed task detection, submission, polling, and report delivery.
- **n8n:** optional local workflow UI scaffold. The current FastAPI task lifecycle does **not** call n8n.

## Repository layout

```text
.
├── api/
│   ├── main.py             # FastAPI API and OpenClaw subprocess coordinator
│   ├── test_main.py        # Unit tests for prompt/output helpers
│   ├── requirements.txt    # Python API dependencies
│   └── .env.example        # API configuration template
├── extension/
│   ├── manifest.json       # Chrome Manifest V3 configuration
│   ├── background.js       # API submission, polling, and report delivery
│   ├── content.js          # Detect tagged tasks and interact with ChatGPT
│   ├── popup.html          # Extension popup interface and styles
│   └── popup.js            # Popup settings and Open/Close controls
├── compose.yaml            # Optional n8n deployment
├── .env.example            # Optional n8n environment template
├── BRIDGE_REFERENCE.md     # Detailed file/function/flow reference
└── README.md
```

## Prerequisites

- Windows 10 or 11.
- Python 3.10 or newer (Python 3.12 is a good default for the API virtual environment).
- OpenClaw installed and working for the same Windows user that runs the API.
- Node.js, if your OpenClaw installation is invoked through its `.mjs` entrypoint (the supplied configuration uses Node).
- Chrome or another Chromium-based browser.
- Docker Desktop only if you also want the optional n8n service.

## Getting started on Windows

The steps below run the FastAPI bridge and browser extension. They assume OpenClaw is already installed and its Gateway is available.

### 1. Get the project

Clone the repository, or open the folder you already cloned:

```powershell
git clone https://github.com/KingMagnusVII/Arkadiko.git
Set-Location .\Arkadiko
```

If you already have the repository locally, just `Set-Location` to that folder instead.

### 2. Create the API environment

From the repository root:

```powershell
py -3.12 -m venv api\.venv
api\.venv\Scripts\python.exe -m pip install --upgrade pip
api\.venv\Scripts\python.exe -m pip install -r api\requirements.txt
```

If the Python launcher does not have a 3.12 installation, use another installed Python version that is 3.10 or newer.

### 3. Configure the API

Create the API's local environment file:

```powershell
Copy-Item api\.env.example api\.env
notepad api\.env
```

Edit and save these values:

- `BRIDGE_API_TOKEN`: replace the placeholder with a long random secret. You will enter the same value in the extension popup. Keep it private.
- `OPENCLAW_ENTRYPOINT`: point to the `openclaw.mjs` file installed on your PC. The example contains a Windows Store package path; update it if your installation path differs.
- `OPENCLAW_WORKSPACE`: set the directory OpenClaw should work in, for example `C:\\Magnus\\Code\\DSA`.
- `OPENCLAW_AGENT_ID`: the OpenClaw agent to invoke; the template uses `main`.
- `OPENCLAW_TIMEOUT_SECONDS`: maximum agent runtime; the template uses 300 seconds.

The template's `OPENCLAW_COMMAND=node` means the API launches Node and passes the configured `openclaw.mjs` entrypoint to it. The API forwards the task text unchanged; it does not silently add Python paths, workspace instructions, or file-editing rules. Put task-specific instructions in the task itself and keep OpenClaw's own filesystem/tool permissions appropriately restricted.

### 4. Start OpenClaw and the local API

Make sure OpenClaw is installed and its Gateway is running for your Windows user. Then, from the repository root, start the API:

```powershell
api\.venv\Scripts\python.exe -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8765
```

Keep this terminal open while using Arkadiko. The API listens only on loopback at `http://127.0.0.1:8765`.

Open a second PowerShell terminal and check the health endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "openclaw-chatgpt-bridge-api"
}
```

The health endpoint confirms that FastAPI is alive; it does not prove that the OpenClaw Gateway or agent is reachable.

### 5. Load the browser extension

1. Open `chrome://extensions` in Chrome (or the equivalent extensions page in your Chromium browser).
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `extension` folder.
5. Open or refresh a ChatGPT conversation at [chatgpt.com](https://chatgpt.com).
6. Click the Arkadiko / OpenClaw Bridge extension icon.
7. Set **Local API URL** to `http://127.0.0.1:8765`.
8. Paste the exact same `BRIDGE_API_TOKEN` value from `api/.env`.
9. Click **Open Bridge**.

If you change extension source files later, return to `chrome://extensions`, press the extension's **Reload** button, and refresh the ChatGPT tab.

### 6. Send a task

Ask ChatGPT for a task formatted with the explicit tags, for example:

```text
<OpenClaw>
Run test.py from my configured workspace and report stdout, stderr, and the exit code. Do not edit any files.
</OpenClaw>
```

While the bridge is open, Arkadiko waits until the assistant message is complete and stable, extracts the contents of the tags, and submits the task. The extension popup shows the latest task and report. When delivery succeeds, the report is also submitted to the same ChatGPT conversation.

Choose **Close Bridge** in the extension popup when you do not want new tagged tasks to be handed off. The bridge is closed by default after initialization; opening it is an explicit user action.

### 7. Run the API unit tests (optional)

From the repository root:

```powershell
api\.venv\Scripts\python.exe -m unittest discover -s api -p "test_*.py" -v
```

These tests cover prompt pass-through and parsing of the OpenClaw CLI output. They do not launch OpenClaw or prove end-to-end browser delivery.

## Optional: start n8n

n8n is not required for the current ChatGPT → FastAPI → OpenClaw flow. If you want to run the optional local n8n UI:

1. Copy the root environment template and set a private encryption key:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

2. Replace `N8N_ENCRYPTION_KEY` with a unique long random value.
3. Start the service:

   ```powershell
   docker compose up -d
   ```

4. Open [http://localhost:5678](http://localhost:5678) and complete n8n's initial owner setup.

The n8n data is stored in the named Docker volume `openclaw-chatgpt-bridge-n8n-data`. Starting n8n does not start FastAPI or OpenClaw, and the current API task lifecycle does not invoke n8n.

## API reference

All task endpoints except `GET /health` require:

```http
Authorization: Bearer <BRIDGE_API_TOKEN>
```

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Unauthenticated API liveness check |
| `POST` | `/v1/tasks` | Submit a task; returns HTTP 202 and a task ID |
| `GET` | `/v1/tasks/{task_id}` | Retrieve task status and execution result |

Example task body:

```json
{ "task": "Run test.py and report stdout, stderr, and exit code." }
```

A task record includes status, stdout, stderr, exit code, timestamps, and an error field when applicable.

## Security and operating boundaries

- Keep `.env`, `api/.env`, tokens, encryption keys, SQLite databases, and execution logs out of Git.
- Keep the API bound to `127.0.0.1`. Do not expose it publicly or change it to `0.0.0.0` without a separately reviewed network-security design.
- The API forwards submitted task text unchanged to the configured OpenClaw agent and captures its structured JSON result. It does not add task instructions or modify OpenClaw settings.
- The configured workspace path is a working-directory setting, **not** an OS-level filesystem sandbox. OpenClaw's actual Windows permissions and tool policies remain the security boundary.
- Do not put passwords, API keys, or other secrets in task text.
- Do not expose n8n or the bridge API to the public internet as part of this local-only setup.
- `manifest.json` is JSON and cannot contain comments; its settings are explained in this README and [BRIDGE_REFERENCE.md](BRIDGE_REFERENCE.md).

## Detailed code reference

See [BRIDGE_REFERENCE.md](BRIDGE_REFERENCE.md) for the architecture, file purposes, function inventory, API contracts, task lifecycle, security boundaries, and known gaps.

## Current milestones

- [x] Initial private repository and project scaffold
- [x] Local n8n Compose deployment definition
- [x] Authenticated FastAPI task API with SQLite task tracking
- [x] Manual extension popup for task submission
- [x] Gateway-backed OpenClaw CLI invocation and JSON result parsing
- [x] Forward submitted task text without repository-generated task instructions
- [x] Result polling and report delivery to the originating ChatGPT conversation
- [x] Initial unit tests for prompt pass-through and output parsing
- [ ] Importable n8n workflow connected to the task lifecycle
- [ ] End-to-end test on the target Windows installation
- [ ] One-command local launcher
- [ ] Independent per-task file-diff reporting

## Useful documentation

- [n8n self-hosting](https://docs.n8n.io/deploy/)
- [n8n Docker Compose](https://docs.n8n.io/hosting/installation/server-setups/docker-compose/)
- [OpenClaw agent CLI](https://docs.openclaw.ai/cli/agent)
