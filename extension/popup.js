// Popup controls for the temporary read-only ChatGPT message capture trial.
const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");
const taskMeta = document.querySelector("#task-meta");
const resultBox = document.querySelector("#result");
const copyButton = document.querySelector("#copy");
const runButton = document.querySelector("#run");
const stopButton = document.querySelector("#stop");

let restoreComplete = false;
let settingsWrite = Promise.resolve();
let latestCapture = null;

function setStatus(message, kind = "neutral") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function paintRunning(running) {
  runButton.dataset.active = String(running);
  stopButton.dataset.active = String(!running);
  runButton.disabled = running;
  stopButton.disabled = !running;
  taskMeta.textContent = running
    ? "READ-ONLY TRIAL: capturing assistant messages only. No task is sent or executed."
    : "Capture is stopped. No messages are read or sent.";
}

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
    "Page: " + (latestCapture.page || ""),
    "",
    "----- COMPLETE CAPTURED ASSISTANT MESSAGE -----",
    latestCapture.text || "",
    "----- END CAPTURE -----"
  ];
  resultBox.textContent = details.join("\n");
  copyButton.hidden = false;
}

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

async function restore() {
  try {
    const saved = await chrome.storage.local.get([
      "endpoint", "token", "bridgeRunning", "bridgeLastStatus", "bridgeCaptureLog"
    ]);
    endpointInput.value = saved.endpoint || "http://127.0.0.1:8765";
    tokenInput.value = saved.token || "";
    restoreComplete = true;
    paintRunning(saved.bridgeRunning === true);
    showCapture(saved.bridgeCaptureLog);
    if (saved.bridgeLastStatus) setStatus(saved.bridgeLastStatus.message, saved.bridgeLastStatus.kind);
    else setStatus(saved.bridgeRunning ? "Capture armed. Waiting for assistant messages." : "Ready. Capture is stopped.");
  } catch (error) {
    setStatus("Could not load saved settings: " + error.message, "error");
  }
}

endpointInput.addEventListener("input", () => persistSettings());
tokenInput.addEventListener("input", () => persistSettings());
endpointInput.addEventListener("change", () => persistSettings(true));
tokenInput.addEventListener("change", () => persistSettings(true));

async function saveConnection() {
  const settings = currentSettings();
  if (!settings.endpoint || !settings.token) throw new Error("Enter both the local API URL and Bridge token.");
  await persistSettings();
  await settingsWrite;
}

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

stopButton.addEventListener("click", async () => {
  await chrome.storage.local.set({
    bridgeRunning: false,
    bridgeLastStatus: { message: "Capture stopped. No messages are being inspected.", kind: "neutral" }
  });
  paintRunning(false);
  setStatus("Capture stopped.");
});

copyButton.addEventListener("click", async () => {
  if (!latestCapture) return;
  try {
    await navigator.clipboard.writeText(latestCapture.text || "");
    setStatus("Captured assistant message copied.");
  } catch (error) {
    setStatus("Could not copy capture: " + error.message, "error");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.bridgeRunning) paintRunning(changes.bridgeRunning.newValue === true);
  if (changes.bridgeLastStatus?.newValue) {
    setStatus(changes.bridgeLastStatus.newValue.message, changes.bridgeLastStatus.newValue.kind);
  }
  if (changes.bridgeCaptureLog) showCapture(changes.bridgeCaptureLog.newValue);
});

restore();
