// Popup UI for the read-only capture trial.
// This file never submits captured content to the local OpenClaw API.
const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");
const taskMeta = document.querySelector("#task-meta");
const diagnosticsBox = document.querySelector("#diagnostics");
const resultBox = document.querySelector("#result");
const copyButton = document.querySelector("#copy");
const runButton = document.querySelector("#run");
const stopButton = document.querySelector("#stop");

let restoreComplete = false;
let settingsWrite = Promise.resolve();
let latestCapture = null;

// Update the main status line without inserting HTML from page content.
function setStatus(message, kind = "neutral") {
  status.textContent = message;
  status.dataset.kind = kind;
}

// Reflect the stored capture switch in the popup controls.
function paintRunning(running) {
  runButton.dataset.active = String(running);
  stopButton.dataset.active = String(!running);
  runButton.disabled = running;
  stopButton.disabled = !running;
  taskMeta.textContent = running
    ? "READ-ONLY TRIAL: capturing assistant messages only. No task is sent or executed."
    : "Capture is stopped. No messages are read or sent.";
}

// Render the most recent captured assistant message as plain text.
function showCapture(log) {
  latestCapture = Array.isArray(log) && log.length ? log[0] : null;
  if (!latestCapture) {
    resultBox.textContent = "";
    copyButton.hidden = true;
    return;
  }

  const details = [
    "Captured: " + (latestCapture.capturedAt || "unknown time"),
    "Characters: " + (latestCapture.characters ?? (latestCapture.text || "").length),
    "Message ID: " + (latestCapture.messageId || "(not exposed by ChatGPT)"),
    "Capture source: " + (latestCapture.source || "unknown"),
    "Page: " + (latestCapture.page || ""),
    "",
    "----- COMPLETE CAPTURED ASSISTANT MESSAGE -----",
    latestCapture.text || "",
    "----- END CAPTURE -----"
  ];
  resultBox.textContent = details.join("\n");
  copyButton.hidden = false;
}

// Show whether the content script loaded, attached its observer, and found messages.
function showDiagnostics(data) {
  if (!data) {
    diagnosticsBox.textContent = "No content-script diagnostic has arrived yet.\nCheck that the extension is reloaded and this tab is https://chatgpt.com/ .";
    return;
  }

  const lines = [
    "Content script: " + (data.contentScriptLoaded ? "LOADED" : "not confirmed"),
    "Capture state loaded: " + (data.stateReady ? "yes" : "pending"),
    "Capture armed in tab: " + (data.captureArmed ? "YES" : "no"),
    "Observer attached: " + (data.observerConnected ? "yes" : "no"),
    "Assistant message elements found: " + (data.assistantCount ?? 0),
    "DOM mutation batches: " + (data.mutationCount ?? 0),
    "Scans performed: " + (data.scanCount ?? 0),
    "Messages captured: " + (data.captureCount ?? 0),
    "Last event: " + (data.lastEvent || "none"),
    "Last update: " + (data.updatedAt || "unknown"),
    data.lastError ? "Last error: " + data.lastError : ""
  ].filter(Boolean);
  diagnosticsBox.textContent = lines.join("\n");
}

// Persist connection fields as typed; they are retained for later restoration but unused in this trial.
function currentSettings() {
  return {
    endpoint: endpointInput.value.trim().replace(/\/$/, ""),
    token: tokenInput.value.trim()
  };
}

function persistSettings(showConfirmation = false) {
  if (!restoreComplete) return settingsWrite;
  const settings = currentSettings();
  settingsWrite = settingsWrite
    .catch(() => {})
    .then(() => chrome.storage.local.set(settings))
    .then(() => {
      if (showConfirmation) setStatus("Connection settings saved locally.");
    })
    .catch(error => setStatus("Could not save settings: " + error.message, "error"));
  return settingsWrite;
}

// Restore popup state and the most recent capture/diagnostics when it opens.
async function restore() {
  try {
    const saved = await chrome.storage.local.get([
      "endpoint", "token", "bridgeRunning", "bridgeLastStatus",
      "bridgeCaptureLog", "bridgeCaptureDiagnostics"
    ]);
    endpointInput.value = saved.endpoint || "http://127.0.0.1:8765";
    tokenInput.value = saved.token || "";
    restoreComplete = true;
    paintRunning(saved.bridgeRunning === true);
    showCapture(saved.bridgeCaptureLog);
    showDiagnostics(saved.bridgeCaptureDiagnostics);

    if (saved.bridgeLastStatus) {
      setStatus(saved.bridgeLastStatus.message, saved.bridgeLastStatus.kind);
    } else {
      setStatus(saved.bridgeRunning ? "Capture armed. Waiting for assistant messages." : "Ready. Capture is stopped.");
    }
  } catch (error) {
    setStatus("Could not load saved settings: " + error.message, "error");
  }
}

endpointInput.addEventListener("input", () => persistSettings());
tokenInput.addEventListener("input", () => persistSettings());
endpointInput.addEventListener("change", () => persistSettings(true));
tokenInput.addEventListener("change", () => persistSettings(true));

// Start capture only; no endpoint, token, fetch, or OpenClaw task submission is involved.
runButton.addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({
      bridgeRunning: true,
      bridgeLastStatus: {
        message: "Read-only capture armed. Assistant messages will be displayed here; nothing will be sent to OpenClaw.",
        kind: "working"
      }
    });
    paintRunning(true);
    setStatus("Read-only capture armed. Nothing will be sent to OpenClaw.", "working");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

// Stop further inspection without deleting previously captured diagnostic text.
stopButton.addEventListener("click", async () => {
  await chrome.storage.local.set({
    bridgeRunning: false,
    bridgeLastStatus: { message: "Capture stopped. No messages are being inspected.", kind: "neutral" }
  });
  paintRunning(false);
  setStatus("Capture stopped.");
});

// Copy only the latest captured assistant message, not the diagnostic wrapper.
copyButton.addEventListener("click", async () => {
  if (!latestCapture) return;
  try {
    await navigator.clipboard.writeText(latestCapture.text || "");
    setStatus("Captured assistant message copied.");
  } catch (error) {
    setStatus("Could not copy capture: " + error.message, "error");
  }
});

// Keep the open popup synchronized with changes made by the content script.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.bridgeRunning) paintRunning(changes.bridgeRunning.newValue === true);
  if (changes.bridgeLastStatus?.newValue) {
    setStatus(changes.bridgeLastStatus.newValue.message, changes.bridgeLastStatus.newValue.kind);
  }
  if (changes.bridgeCaptureLog) showCapture(changes.bridgeCaptureLog.newValue);
  if (changes.bridgeCaptureDiagnostics) showDiagnostics(changes.bridgeCaptureDiagnostics.newValue);
});

restore();
