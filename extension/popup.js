// Popup controller for the manual ChatGPT -> local API -> OpenClaw handoff.
// Runs in the extension popup, not inside the ChatGPT page.

const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const taskInput = document.querySelector("#task");
const status = document.querySelector("#status");
const resultBox = document.querySelector("#result");
const checkButton = document.querySelector("#check");
const copyButton = document.querySelector("#copy");
const sendButton = document.querySelector("#send");
const taskMeta = document.querySelector("#task-meta");

// These values are persisted so closing/reopening the popup does not lose the active task.
let latestTaskId = null;
let latestReport = "";
let latestTaskStatus = null;

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const FINAL_STATUSES = new Set(["completed", "failed"]);

function setStatus(message, kind = "neutral") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function updateTaskControls() {
  checkButton.disabled = !latestTaskId;
  taskMeta.textContent = latestTaskId
    ? `Task ${latestTaskId} · ${latestTaskStatus || "saved"}`
    : "No active task";
}

async function saveState(extra = {}) {
  await chrome.storage.local.set({
    endpoint: endpointInput.value.trim().replace(/\/$/, ""),
    token: tokenInput.value.trim(),
    task: taskInput.value,
    latestTaskId,
    latestTaskStatus,
    latestReport,
    ...extra
  });
}

async function restoreState() {
  const saved = await chrome.storage.local.get([
    "endpoint",
    "token",
    "task",
    "latestTaskId",
    "latestTaskStatus",
    "latestReport"
  ]);

  if (saved.endpoint) endpointInput.value = saved.endpoint;
  if (saved.token) tokenInput.value = saved.token;
  if (saved.task) taskInput.value = saved.task;

  latestTaskId = saved.latestTaskId || null;
  latestTaskStatus = saved.latestTaskStatus || null;
  latestReport = saved.latestReport || "";

  updateTaskControls();

  if (latestReport && FINAL_STATUSES.has(latestTaskStatus)) {
    resultBox.textContent = latestReport;
    resultBox.hidden = false;
    copyButton.hidden = false;
    setStatus(`Task ${latestTaskId} is ${latestTaskStatus}.`, latestTaskStatus);
  } else if (latestTaskId && ACTIVE_STATUSES.has(latestTaskStatus)) {
    setStatus(`Still working — OpenClaw is processing task ${latestTaskId}.`, "working");
  } else if (latestTaskId) {
    setStatus(`Task ${latestTaskId} is saved. Click Check latest result.`, "neutral");
  }
}

function authHeaders() {
  const token = tokenInput.value.trim();
  if (!token) throw new Error("Enter the bridge token.");
  return { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
}

function renderReport(data) {
  latestReport = [
    `Task ID: ${data.task_id}`,
    `Status: ${data.status}`,
    `Exit code: ${data.exit_code ?? "not available"}`,
    data.error ? `Error: ${data.error}` : "",
    "STDOUT:",
    data.stdout || "(empty)",
    "STDERR:",
    data.stderr || "(empty)"
  ].filter(Boolean).join("\n");
  resultBox.textContent = latestReport;
  resultBox.hidden = false;
  copyButton.hidden = false;
}

sendButton.addEventListener("click", async () => {
  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  const task = taskInput.value.trim();
  if (!task) {
    setStatus("Enter a task.", "error");
    return;
  }

  setStatus("Submitting task...", "working");
  resultBox.hidden = true;
  copyButton.hidden = true;
  sendButton.disabled = true;

  try {
    await chrome.storage.local.set({ endpoint, token: tokenInput.value.trim(), task });
    const response = await fetch(`${endpoint}/v1/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ task })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || response.statusText);

    latestTaskId = payload.task_id;
    latestTaskStatus = payload.status || "queued";
    latestReport = "";
    await saveState();
    updateTaskControls();

    setStatus(
      `Queued for OpenClaw. Task ${latestTaskId} is now in the bridge queue.`,
      "queued"
    );
  } catch (error) {
    setStatus(`Failed: ${error.message}`, "error");
  } finally {
    sendButton.disabled = false;
  }
});

checkButton.addEventListener("click", async () => {
  if (!latestTaskId) {
    setStatus("No task is currently saved.", "error");
    return;
  }

  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  setStatus("Checking task...", "working");
  checkButton.disabled = true;

  try {
    const response = await fetch(`${endpoint}/v1/tasks/${encodeURIComponent(latestTaskId)}`, {
      headers: authHeaders()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || response.statusText);

    latestTaskStatus = data.status;
    await saveState();
    updateTaskControls();

    if (FINAL_STATUSES.has(data.status)) {
      renderReport(data);
      await saveState();
      setStatus(`Task ${data.task_id} finished with status: ${data.status}.`, data.status);
    } else if (ACTIVE_STATUSES.has(data.status)) {
      setStatus(
        `Still working — OpenClaw has not finished task ${data.task_id} yet. Check again later.`,
        "working"
      );
    } else {
      setStatus(`Task ${data.task_id}: ${data.status}.`, "neutral");
    }
  } catch (error) {
    setStatus(`Failed: ${error.message}`, "error");
  } finally {
    checkButton.disabled = !latestTaskId;
  }
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(latestReport);
    setStatus("Report copied. Paste it into your ChatGPT conversation.", "completed");
  } catch (error) {
    setStatus(`Could not copy report: ${error.message}`, "error");
  }
});

for (const input of [endpointInput, tokenInput, taskInput]) {
  input.addEventListener("input", () => {
    // Keep user-entered endpoint/token/task available even before Send is clicked.
    chrome.storage.local.set({
      endpoint: endpointInput.value.trim().replace(/\/$/, ""),
      token: tokenInput.value.trim(),
      task: taskInput.value
    });
  });
}

restoreState();
