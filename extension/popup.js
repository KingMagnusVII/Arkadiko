// Popup controls for the user-armed automatic ChatGPT <-> OpenClaw bridge.
const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");
const taskMeta = document.querySelector("#task-meta");
const resultBox = document.querySelector("#result");
const runButton = document.querySelector("#run");
const stopButton = document.querySelector("#stop");

let restoreComplete = false;
let settingsWrite = Promise.resolve();

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
    ? "Automation is running. Only explicit OpenClaw task markers will be handed off."
    : "Automation is stopped. Ordinary ChatGPT messages are unaffected.";
}

function currentSettings() {
  return {
    endpoint: endpointInput.value.trim().replace(/\/$/, ""),
    token: tokenInput.value.trim()
  };
}

// Queue writes so rapid typing cannot let an older storage write finish last.
function persistSettings(showConfirmation = false) {
  if (!restoreComplete) return settingsWrite;
  const settings = currentSettings();
  settingsWrite = settingsWrite
    .catch(() => {})
    .then(() => chrome.storage.local.set(settings))
    .then(() => {
      if (showConfirmation) setStatus("Connection settings saved locally.");
    })
    .catch((error) => setStatus(`Could not save settings: ${error.message}`, "error"));
  return settingsWrite;
}

async function restore() {
  try {
    const saved = await chrome.storage.local.get([
      "endpoint", "token", "bridgeRunning", "bridgeLastStatus"
    ]);
    endpointInput.value = saved.endpoint || "http://127.0.0.1:8765";
    tokenInput.value = saved.token || "";
    restoreComplete = true;

    const running = saved.bridgeRunning === true;
    paintRunning(running);
    if (saved.bridgeLastStatus) {
      setStatus(saved.bridgeLastStatus.message, saved.bridgeLastStatus.kind);
    } else {
      setStatus(running ? "Bridge armed and listening for marked tasks." : "Ready. Automation is stopped.");
    }
  } catch (error) {
    setStatus(`Could not load saved settings: ${error.message}`, "error");
  }
}

// Persist edits as they are made, not only when Run OpenClaw is clicked.
endpointInput.addEventListener("input", () => persistSettings());
tokenInput.addEventListener("input", () => persistSettings());
endpointInput.addEventListener("change", () => persistSettings(true));
tokenInput.addEventListener("change", () => persistSettings(true));

async function saveConnection() {
  const settings = currentSettings();
  if (!settings.endpoint || !settings.token) {
    throw new Error("Enter both the local API URL and Bridge token.");
  }
  await persistSettings();
  await settingsWrite;
}

runButton.addEventListener("click", async () => {
  try {
    await saveConnection();
    await chrome.storage.local.set({
      bridgeRunning: true,
      bridgeLastStatus: {
        message: "Bridge armed. Waiting for an explicitly marked OpenClaw task.",
        kind: "working"
      }
    });
    paintRunning(true);
    setStatus("Bridge armed. Waiting for an explicitly marked OpenClaw task.", "working");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

stopButton.addEventListener("click", async () => {
  await chrome.storage.local.set({
    bridgeRunning: false,
    bridgeLastStatus: {
      message: "Bridge stopped. No new tasks or automatic report submissions.",
      kind: "neutral"
    }
  });
  paintRunning(false);
  setStatus("Bridge stopped. No new tasks or automatic report submissions.");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.bridgeRunning) paintRunning(changes.bridgeRunning.newValue === true);
  if (changes.bridgeLastStatus?.newValue) {
    setStatus(changes.bridgeLastStatus.newValue.message, changes.bridgeLastStatus.newValue.kind);
  }
});

restore();
