// Controls the extension popup for the manual ChatGPT -> local API -> OpenClaw handoff.
// This script runs in the popup only; it does not scrape ChatGPT or auto-submit messages.

// Cache the HTML controls once so every event handler updates the same elements.
const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const taskInput = document.querySelector("#task");
const status = document.querySelector("#status");
const resultBox = document.querySelector("#result");
const checkButton = document.querySelector("#check");
const copyButton = document.querySelector("#copy");
const sendButton = document.querySelector("#send");
const taskMeta = document.querySelector("#task-meta");

// Track the most recently submitted task and report while the popup is open.
// These values are also persisted in extension storage below.
let latestTaskId = null;
let latestReport = "";
let latestTaskStatus = null;

// Group task states so the UI can distinguish in-progress and terminal results.
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const FINAL_STATUSES = new Set(["completed", "failed"]);

// Set the visible status message and its styling category.
function setStatus(message, kind = "neutral") {
  status.textContent = message;
  status.dataset.kind = kind;
}

// Enable manual result checks only after a task ID has been received.
function updateTaskControls() {
  checkButton.disabled = !latestTaskId;
  taskMeta.textContent = latestTaskId
    ? `Task ${latestTaskId} · ${latestTaskStatus || "saved"}`
    : "No active task";
}

// Save current form values and task state so they survive popup closure.
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

// Restore saved settings and the latest task when the popup is opened.
async function restoreState() {
  const saved = await chrome.storage.local.get([
    "endpoint",
    "token",
    "task",
    "latestTaskId",
    "latestTaskStatus",
    "latestReport"
  ]);

  // Keep the HTML defaults when a setting has never been saved.
  if (saved.endpoint) endpointInput.value = saved.endpoint;
  if (saved.token) tokenInput.value = saved.token;
  if (saved.task) taskInput.value = saved.task;

  // Restore the task tracking values used by the Check and Copy actions.
  latestTaskId = saved.latestTaskId || null;
  latestTaskStatus = saved.latestTaskStatus || null;
  latestReport = saved.latestReport || "";

  updateTaskControls();

  // Show a saved report for a finished task, or explain how to check an active one.
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

// Build the authentication headers required by the protected FastAPI routes.
function authHeaders() {
  const token = tokenInput.value.trim();
  if (!token) throw new Error("Enter the bridge token.");
  return { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
}

// Format the returned task data as plain text for display and copying.
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

  // textContent ensures process output is displayed as text, not interpreted as HTML.
  resultBox.textContent = latestReport;
  resultBox.hidden = false;
  copyButton.hidden = false;
}

// SEND: create a task only after the user explicitly clicks this button.
sendButton.addEventListener("click", async () => {
  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  const task = taskInput.value.trim();

  // Do not submit a blank task to the API.
  if (!task) {
    setStatus("Enter a task.", "error");
    return;
  }

  // Give immediate feedback and prevent duplicate submissions while waiting.
  setStatus("Submitting task...", "working");
  resultBox.hidden = true;
  copyButton.hidden = true;
  sendButton.disabled = true;

  try {
    // Persist the form values before sending the request.
    await chrome.storage.local.set({ endpoint, token: tokenInput.value.trim(), task });

    // POST creates the task; the API returns its ID and initial queued status.
    const response = await fetch(`${endpoint}/v1/tasks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ task })
    });
    const payload = await response.json();

    // Turn HTTP errors into readable popup status messages.
    if (!response.ok) throw new Error(payload.detail || response.statusText);

    // Save the task ID so the user can manually request its result later.
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
    // Covers connection failures, authentication errors, and API validation errors.
    setStatus(`Failed: ${error.message}`, "error");
  } finally {
    // Re-enable Send regardless of whether submission succeeded.
    sendButton.disabled = false;
  }
});

// CHECK: request task status only on a user click; this extension does not auto-poll.
checkButton.addEventListener("click", async () => {
  if (!latestTaskId) {
    setStatus("No task is currently saved.", "error");
    return;
  }

  const endpoint = endpointInput.value.trim().replace(/\/$/, "");
  setStatus("Checking task...", "working");
  checkButton.disabled = true;

  try {
    // Encode the task ID before inserting it into the URL path.
    const response = await fetch(`${endpoint}/v1/tasks/${encodeURIComponent(latestTaskId)}`, {
      headers: authHeaders()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || response.statusText);

    // Save the latest status so the popup can restore it next time.
    latestTaskStatus = data.status;
    await saveState();
    updateTaskControls();

    if (FINAL_STATUSES.has(data.status)) {
      // Both completed and failed tasks have a final report worth displaying.
      renderReport(data);
      await saveState();
      setStatus(`Task ${data.task_id} finished with status: ${data.status}.`, data.status);
    } else if (ACTIVE_STATUSES.has(data.status)) {
      // The user can click Check again later while OpenClaw is still working.
      setStatus(
        `Still working — OpenClaw has not finished task ${data.task_id} yet. Check again later.`,
        "working"
      );
    } else {
      // Keep any unrecognized future status visible instead of hiding it.
      setStatus(`Task ${data.task_id}: ${data.status}.`, "neutral");
    }
  } catch (error) {
    setStatus(`Failed: ${error.message}`, "error");
  } finally {
    // Keep Check enabled whenever a task ID is available.
    checkButton.disabled = !latestTaskId;
  }
});

// COPY: put the formatted report on the clipboard for a deliberate paste into ChatGPT.
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(latestReport);
    setStatus("Report copied. Paste it into your ChatGPT conversation.", "completed");
  } catch (error) {
    // Clipboard access can fail when the browser denies the operation.
    setStatus(`Could not copy report: ${error.message}`, "error");
  }
});

// Save form edits as the user types, even if they close the popup before pressing Send.
for (const input of [endpointInput, tokenInput, taskInput]) {
  input.addEventListener("input", () => {
    chrome.storage.local.set({
      endpoint: endpointInput.value.trim().replace(/\/$/, ""),
      token: tokenInput.value.trim(),
      task: taskInput.value
    });
  });
}

// Initialize the popup from previously saved extension-local state.
restoreState();
