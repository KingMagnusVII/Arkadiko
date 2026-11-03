const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");
const taskMeta = document.querySelector("#task-meta");
const resultBox = document.querySelector("#result");
const copyButton = document.querySelector("#copy");
const openButton = document.querySelector("#run");
const closeButton = document.querySelector("#stop");

let restoreComplete = false;
let settingsWrite = Promise.resolve();
let latestReport = "";

function setStatus(message, kind = "neutral") {
  status.textContent = message || "Ready.";
  status.dataset.kind = kind;
}

function paintBridgeOpen(open) {
  openButton.dataset.active = String(open);
  closeButton.dataset.active = String(!open);
  openButton.disabled = open;
  closeButton.disabled = !open;
  taskMeta.textContent = open
    ? "Bridge open · waiting for a complete <OpenClaw> task."
    : "Bridge closed · new tagged tasks will not be sent.";
}

function renderLatest(saved) {
  const queued = saved.bridgeQueuedTask;
  const lastResult = saved.bridgeLastResult;
  if (lastResult?.report) {
    latestReport = lastResult.report;
    resultBox.textContent = lastResult.report;
    copyButton.hidden = false;
    taskMeta.textContent = "Latest task · " + (lastResult.receivedAt || "result received");
    return;
  }
  if (queued?.task) {
    latestReport = queued.task;
    resultBox.textContent = "QUEUED TASK\n\n" + queued.task;
    copyButton.hidden = false;
    taskMeta.textContent = "Latest task received · " + (queued.queuedAt || "queued");
    return;
  }
  latestReport = "";
  resultBox.textContent = "";
  copyButton.hidden = true;
}

function currentSettings() {
  return {
    endpoint: endpointInput.value.trim().replace(/\/$/, ""),
    token: tokenInput.value.trim()
  };
}

function persistSettings(showConfirmation = false) {
  if (!restoreComplete) return settingsWrite;
  settingsWrite = settingsWrite.catch(() => {})
    .then(() => chrome.storage.local.set(currentSettings()))
    .then(() => { if (showConfirmation) setStatus("Connection settings saved locally."); })
    .catch(error => setStatus("Could not save settings: " + error.message, "error"));
  return settingsWrite;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

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

endpointInput.addEventListener("input", () => persistSettings());
tokenInput.addEventListener("input", () => persistSettings());
endpointInput.addEventListener("change", () => persistSettings(true));
tokenInput.addEventListener("change", () => persistSettings(true));

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

copyButton.addEventListener("click", async () => {
  if (!latestReport) return;
  try {
    await navigator.clipboard.writeText(latestReport);
    setStatus("Copied latest task/report.");
  } catch (error) {
    setStatus("Could not copy: " + error.message, "error");
  }
});

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

restore();
