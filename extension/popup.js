// Arkadiko popup controller: restores settings, opens/closes the bridge, and displays the latest report.

// Cache references to popup elements once; the popup document is recreated whenever it is opened.
const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");
const taskMeta = document.querySelector("#task-meta");
const resultBox = document.querySelector("#result");
const copyButton = document.querySelector("#copy");
const deleteReportButton = document.querySelector("#delete-report");
const openButton = document.querySelector("#run");
const closeButton = document.querySelector("#stop");

// Prevent edits from racing the initial storage restore, and serialize settings writes.
let restoreComplete = false;
let settingsWrite = Promise.resolve();
let latestReport = "";

// Update the accessible status text and its visual state.
function setStatus(message, kind = "neutral") {
  status.textContent = message || "Ready.";
  status.dataset.kind = kind;
}

// Keep the Open/Close buttons and helper text consistent with the persisted bridge state.
function paintBridgeOpen(open) {
  openButton.dataset.active = String(open);
  closeButton.dataset.active = String(!open);
  openButton.disabled = open;
  closeButton.disabled = !open;
  taskMeta.textContent = open
    ? "Bridge open · waiting for a complete <OpenClaw> task."
    : "Bridge closed · new tagged tasks will not be sent.";
}

// Display the most recent completed report, or the latest queued task if no report exists yet.
function renderLatest(saved) {
  const queued = saved.bridgeQueuedTask;
  const lastResult = saved.bridgeLastResult;
  if (lastResult?.report) {
    latestReport = lastResult.report;
    resultBox.textContent = lastResult.report;
    copyButton.hidden = false;
    deleteReportButton.hidden = false;
    taskMeta.textContent = "Latest task · " + (lastResult.receivedAt || "result received");
    return;
  }
  if (queued?.task) {
    latestReport = queued.task;
    resultBox.textContent = "QUEUED TASK\n\n" + queued.task;
    copyButton.hidden = false;
    deleteReportButton.hidden = true;
    taskMeta.textContent = "Latest task received · " + (queued.queuedAt || "queued");
    return;
  }
  latestReport = "";
  resultBox.textContent = "";
  copyButton.hidden = true;
  deleteReportButton.hidden = true;
}

// Read the current endpoint and token fields in the normalized format used by the service worker.
function currentSettings() {
  return {
    endpoint: endpointInput.value.trim().replace(/\/$/, ""),
    token: tokenInput.value.trim()
  };
}

// Persist settings in order so rapid keystrokes cannot finish out of order.
function persistSettings(showConfirmation = false) {
  if (!restoreComplete) return settingsWrite;
  settingsWrite = settingsWrite.catch(() => {})
    .then(() => chrome.storage.local.set(currentSettings()))
    .then(() => { if (showConfirmation) setStatus("Connection settings saved locally."); })
    .catch(error => setStatus("Could not save settings: " + error.message, "error"));
  return settingsWrite;
}

// Return the active browser tab, or null if no tab is active.
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

// Send Open/Close commands to the content script in the active ChatGPT tab.
async function sendBridgeCommand(type) {
  const tab = await getActiveTab();
  if (!tab?.id || !/^https:\/\/chatgpt\.com\//.test(tab.url || "")) {
    throw new Error("Open your ChatGPT conversation first.");
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type });
    if (response?.ok === false) throw new Error(response.error || "Bridge command failed.");
    return response;
  } catch (error) {
    throw new Error("Could not reach the ChatGPT tab. Reload the extension and refresh ChatGPT. " + error.message);
  }
}

// Restore saved connection settings, bridge state, and the latest task/report when the popup opens.
async function restore() {
  try {
    const saved = await chrome.storage.local.get([
      "endpoint", "token", "bridgeRunning", "bridgeLastStatus",
      "bridgeQueuedTask", "bridgeLastResult"
    ]);
    endpointInput.value = saved.endpoint || "http://127.0.0.1:8765";
    tokenInput.value = saved.token || "";
    restoreComplete = true;
    paintBridgeOpen(saved.bridgeRunning === true);
    renderLatest(saved);
    setStatus(saved.bridgeLastStatus?.message || (saved.bridgeRunning ? "Bridge is open." : "Bridge is closed."), saved.bridgeLastStatus?.kind);
  } catch (error) {
    setStatus("Could not load settings: " + error.message, "error");
  }
}

// Save endpoint/token changes as the user edits them; confirm when a field loses focus.
endpointInput.addEventListener("input", () => persistSettings());
tokenInput.addEventListener("input", () => persistSettings());
endpointInput.addEventListener("change", () => persistSettings(true));
tokenInput.addEventListener("change", () => persistSettings(true));

// Open Bridge is an explicit user action; the content script then watches only new assistant turns.
openButton.addEventListener("click", async () => {
  try {
    await persistSettings();
    await sendBridgeCommand("openclaw-bridge-open");
    await chrome.storage.local.set({ bridgeRunning: true });
    paintBridgeOpen(true);
    setStatus("Bridge open. Waiting for tagged tasks.", "working");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

// Close Bridge stops new task detection/handoffs without deleting saved settings or reports.
closeButton.addEventListener("click", async () => {
  try {
    await sendBridgeCommand("openclaw-bridge-close");
    await chrome.storage.local.set({
      bridgeRunning: false,
      bridgeLastStatus: { message: "Bridge closed. No new tasks will be handed off.", kind: "neutral" }
    });
    paintBridgeOpen(false);
    setStatus("Bridge closed.");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

// Copy the latest queued task or execution report for manual use.
copyButton.addEventListener("click", async () => {
  if (!latestReport) return;
  try {
    await navigator.clipboard.writeText(latestReport);
    setStatus("Copied latest task/report.");
  } catch (error) {
    setStatus("Could not copy: " + error.message, "error");
  }
});

// Delete only the latest completed/failed report from the API and this popup's saved state.
deleteReportButton.addEventListener("click", async () => {
  const saved = await chrome.storage.local.get(["endpoint", "token", "bridgeLastResult"]);
  const latest = saved.bridgeLastResult;
  if (!latest?.taskId) {
    setStatus("There is no finished report to delete.", "error");
    return;
  }
  // Require an explicit confirmation because deletion removes the stored report from SQLite.
  if (!window.confirm("Delete the latest report? This cannot be undone.")) return;
  try {
    const endpoint = (saved.endpoint || "http://127.0.0.1:8765").trim().replace(/\/$/, "");
    const token = (saved.token || "").trim();
    if (!token) throw new Error("Add your local Bridge token in the extension popup first.");
    const response = await fetch(endpoint + "/v1/tasks/" + encodeURIComponent(latest.taskId), {
      method: "DELETE",
      headers: { "Authorization": "Bearer " + token }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.detail || response.statusText || "Could not delete the latest report.";
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    // Clear only the report/task preview that was just deleted; preserve connection settings and other data.
    await chrome.storage.local.set({
      bridgeLastResult: null,
      bridgeQueuedTask: null,
      bridgeLastStatus: { message: "Latest report deleted.", kind: "neutral" }
    });
    latestReport = "";
    resultBox.textContent = "";
    copyButton.hidden = true;
    deleteReportButton.hidden = true;
    taskMeta.textContent = "Latest report deleted.";
    setStatus("Latest report deleted.");
  } catch (error) {
    setStatus("Could not delete report: " + error.message, "error");
  }
});

// Keep the popup view synchronized when the service worker/content script changes shared storage.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.bridgeRunning) paintBridgeOpen(changes.bridgeRunning.newValue === true);
  if (changes.bridgeLastStatus?.newValue) {
    setStatus(changes.bridgeLastStatus.newValue.message, changes.bridgeLastStatus.newValue.kind);
  }
  if (changes.bridgeQueuedTask || changes.bridgeLastResult) {
    chrome.storage.local.get(["bridgeQueuedTask", "bridgeLastResult"]).then(renderLatest);
  }
});

// Initialize controls and saved state after the popup DOM is ready.
restore();
