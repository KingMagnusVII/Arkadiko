"""Local FastAPI relay between the browser extension and the OpenClaw agent CLI.

The module owns task validation, bearer-token authentication, SQLite persistence,
prompt construction, subprocess execution, timeout handling, and result retrieval.
It deliberately does not alter OpenClaw pairing or execution-approval settings.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sqlite3
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

# Resolve configuration relative to this source file, then fall back to the repo root.
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR.parent / ".env")

# Runtime configuration is loaded once when this module is imported.
TOKEN = os.getenv("BRIDGE_API_TOKEN", "")
OPENCLAW_COMMAND = os.getenv("OPENCLAW_COMMAND", "openclaw")
OPENCLAW_ENTRYPOINT = os.getenv("OPENCLAW_ENTRYPOINT", "")
OPENCLAW_AGENT_ID = os.getenv("OPENCLAW_AGENT_ID", "main")
WORKSPACE = Path(os.getenv("OPENCLAW_WORKSPACE", r"C:\Magnus\Code\DSA")).expanduser().resolve()
TIMEOUT = max(10, int(os.getenv("OPENCLAW_TIMEOUT_SECONDS", "300")))
DB_PATH = Path(os.getenv("BRIDGE_DB_PATH", str(BASE_DIR / "bridge.sqlite3"))).resolve()

# FastAPI exposes the HTTP endpoints consumed by extension/popup.js.
app = FastAPI(title="OpenClaw ChatGPT Bridge API", version="0.2.0")


class TaskRequest(BaseModel):
    """Validated body for POST /v1/tasks; task text is limited to 12,000 chars."""
    task: str = Field(min_length=1, max_length=12000)


def utc_now() -> str:
    """Return an ISO-8601 UTC timestamp for task lifecycle records."""
    return datetime.now(timezone.utc).isoformat()


def connect_db() -> sqlite3.Connection:
    """Open the SQLite ledger and create its tasks table if it is not present."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute(
        """CREATE TABLE IF NOT EXISTS tasks (
            task_id TEXT PRIMARY KEY,
            task TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            stdout TEXT,
            stderr TEXT,
            exit_code INTEGER,
            error TEXT
        )"""
    )
    db.commit()
    return db


@contextmanager
def db_connection() -> Iterator[sqlite3.Connection]:
    """Commit on success, roll back on error, and always close the connection."""
    db = connect_db()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def require_token(authorization: str | None = Header(default=None)) -> None:
    """Reject requests unless their Bearer token matches the configured secret."""
    if not TOKEN or TOKEN.startswith("replace-with-"):
        raise HTTPException(status_code=503, detail="Bridge token is not configured.")
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(supplied, TOKEN):
        raise HTTPException(status_code=401, detail="Invalid bridge token.")


def task_record(row: sqlite3.Row) -> dict[str, Any]:
    """Convert a SQLite row into a JSON-serializable dictionary."""
    return dict(row)


def build_agent_prompt(task: str) -> str:
    """Pass the submitted task to OpenClaw without adding repository instructions."""
    return task

def extract_agent_output(raw_stdout: str) -> tuple[str, str | None]:
    """Extract the agent's final text and any structured error from CLI JSON."""
    """Return user-facing final text and a structured CLI error, if present."""
    try:
        payload = json.loads(raw_stdout)
    except json.JSONDecodeError:
        return raw_stdout, None

    if not isinstance(payload, dict):
        return raw_stdout, None

    final_text = payload.get("final")
    if not isinstance(final_text, str):
        parts = payload.get("payloads")
        if isinstance(parts, list):
            texts = [
                item.get("text")
                for item in parts
                if isinstance(item, dict) and isinstance(item.get("text"), str)
            ]
            final_text = "\n".join(texts) if texts else raw_stdout
        else:
            final_text = raw_stdout

    error = payload.get("error")
    error_text = None
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message:
            error_text = message
    elif isinstance(error, str) and error:
        error_text = error

    if payload.get("ok") is False and not error_text:
        error_text = "OpenClaw reported an unsuccessful agent run."
    return final_text, error_text


async def run_openclaw(task_id: str, task: str) -> None:
    """Run one agent turn, persist its outcome, enforce timeout, and clean temp input."""
    prompt_path: str | None = None
    process: asyncio.subprocess.Process | None = None

    # Mark the task running before preparing and launching the external process.
    with db_connection() as db:
        db.execute(
            "UPDATE tasks SET status='running', started_at=? WHERE task_id=?",
            (utc_now(), task_id),
        )

    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", suffix=".txt", delete=False
        ) as prompt_file:
            prompt_file.write(build_agent_prompt(task))
            prompt_path = prompt_file.name

        # Use the installed OpenClaw CLI through Node when an .mjs entrypoint is set.
        command = [OPENCLAW_COMMAND]
        if OPENCLAW_ENTRYPOINT:
            command.append(OPENCLAW_ENTRYPOINT)
        command.extend(
            [
                "agent",
                "--agent",
                OPENCLAW_AGENT_ID,
                "--message-file",
                prompt_path,
                "--timeout",
                str(TIMEOUT),
                "--json",
            ]
        )

        # Capture both streams; communicate() drains them and waits for process exit.
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(WORKSPACE),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(), timeout=TIMEOUT + 15
        )
        raw_stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        stdout, agent_error = extract_agent_output(raw_stdout)

        # A zero OS exit code is not enough if the agent JSON itself reports an error.
        success = process.returncode == 0 and agent_error is None
        with connect_db() as db:
            db.execute(
                """UPDATE tasks
                   SET status=?, completed_at=?, stdout=?, stderr=?, exit_code=?, error=?
                   WHERE task_id=?""",
                (
                    "completed" if success else "failed",
                    utc_now(),
                    stdout,
                    stderr,
                    process.returncode,
                    agent_error,
                    task_id,
                ),
            )
    except asyncio.TimeoutError:
        # Stop a process that exceeded the configured deadline and record a failed task.
        if process is not None and process.returncode is None:
            process.kill()
            await process.communicate()
        with connect_db() as db:
            db.execute(
                "UPDATE tasks SET status='failed', completed_at=?, error=? WHERE task_id=?",
                (utc_now(), f"OpenClaw did not finish within {TIMEOUT} seconds.", task_id),
            )
    except Exception as exc:
        with connect_db() as db:
            db.execute(
                "UPDATE tasks SET status='failed', completed_at=?, error=? WHERE task_id=?",
                (utc_now(), f"{type(exc).__name__}: {exc}", task_id),
            )
    finally:
        # The prompt file contains the submitted task; remove it after every outcome.
        if prompt_path:
            Path(prompt_path).unlink(missing_ok=True)


@app.on_event("startup")
async def startup() -> None:
    """Ensure the task ledger exists before the API accepts requests."""
    connect_db()


@app.get("/health")
async def health() -> dict[str, str]:
    """Unauthenticated liveness endpoint; it does not test OpenClaw connectivity."""
    return {"status": "ok", "service": "openclaw-chatgpt-bridge-api"}


@app.post("/v1/tasks", dependencies=[Depends(require_token)], status_code=202)
async def submit_task(body: TaskRequest) -> dict[str, str]:
    """Persist a queued task, start its background agent run, and return its ID."""
    task = body.task.strip()
    if not task:
        raise HTTPException(status_code=422, detail="Task cannot be blank.")

    task_id = str(uuid.uuid4())
    with connect_db() as db:
        db.execute(
            "INSERT INTO tasks(task_id, task, status, created_at) VALUES (?, ?, 'queued', ?)",
            (task_id, task, utc_now()),
        )
    # Return quickly; the extension polls GET /v1/tasks/{task_id} for completion.
    asyncio.create_task(run_openclaw(task_id, task))
    return {"task_id": task_id, "status": "queued"}


@app.get("/v1/tasks/{task_id}", dependencies=[Depends(require_token)])
async def get_task(task_id: str) -> dict[str, Any]:
    """Return the stored task, streams, exit code, timestamps, and error."""
    with connect_db() as db:
        row = db.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return task_record(row)


@app.delete("/v1/tasks/{task_id}", dependencies=[Depends(require_token)])
async def delete_task(task_id: str) -> dict[str, str]:
    """Delete one finished task and its stored execution report from SQLite."""
    with connect_db() as db:
        # Keep queued or running tasks intact while OpenClaw may still be using them.
        row = db.execute(
            "SELECT status FROM tasks WHERE task_id=?",
            (task_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Task not found.")
        if row["status"] not in ("completed", "failed"):
            raise HTTPException(status_code=409, detail="A task can only be deleted after it has finished.")
        # Delete only the task explicitly selected by the latest-report control.
        db.execute("DELETE FROM tasks WHERE task_id=?", (task_id,))
    return {"status": "deleted", "task_id": task_id}
