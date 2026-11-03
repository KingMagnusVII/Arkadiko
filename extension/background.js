// Extension service worker: authenticated local API handoff and result polling.
const DEFAULT_ENDPOINT = "http://127.0.0.1:8765";
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 165;

async function getConnection() {
  const saved = await chrome.storage.local.get(["endpoint", "token"]);
  const endpoint = (saved.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
  const token = (saved.token || "").trim();
  if (!token) throw new Error("Add your local Bridge token in the extension popup first.");
  return { endpoint, token };
}

async function apiRequest(path, options = {}) {
  const { endpoint, token } = await getConnection();
  const response = await fetch(endpoint + path, {
    ...options,
    headers: {
      "Authorization": "Bearer " + token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.detail || response.statusText || "Local API request failed.";
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatReport(task, result) {
  const lines = [
    "OpenClaw execution report",
    "Status: " + (result.status || "unknown").toUpperCase(),
    "Task: " + task,
    "Exit code: " + (result.exit_code ?? "not available"),
    "",
    "STDOUT:",
    result.stdout || "(empty)",
    "",
    "STDERR:",
    result.stderr || "(empty)"
  ];
  if (result.error) lines.push("", "Error:", result.error);
  lines.push("", "Files changed: not independently measured by the bridge. Ask OpenClaw for its reported file list.");
  return lines.join("\n");
}

async function runTask(taskId, task, tabId) {
  try {
    await chrome.storage.local.set({
      bridgeLastStatus: { message: "OpenClaw is working on the queued task.", kind: "working" }
    });
    let result = null;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      await delay(POLL_INTERVAL_MS);
      result = await apiRequest("/v1/tasks/" + encodeURIComponent(taskId));
      if (result.status === "completed" || result.status === "failed") break;
    }
    if (!result || (result.status !== "completed" && result.status !== "failed")) {
      throw new Error("Timed out while waiting for the OpenClaw task result.");
    }

    const report = formatReport(task, result);
    await chrome.storage.local.set({
      bridgeLastResult: { taskId, task, result, report, receivedAt: new Date().toISOString() },
      bridgeLastStatus: {
        message: "OpenClaw finished. Submitting its report automatically to ChatGPT.",
        kind: "working"
      }
    });

    try {
      const delivery = await chrome.tabs.sendMessage(tabId, {
        type: "openclaw-bridge-insert-result", report
      });
      if (!delivery?.ok || !delivery?.submitted || !delivery?.confirmed) {
        throw new Error(delivery?.error || "ChatGPT did not confirm report submission.");
      }
      await chrome.storage.local.set({
        bridgeLastStatus: {
          message: "Report submitted and ChatGPT confirmed it accepted the message.",
          kind: "completed",
          delivery
        }
      });
    } catch (error) {
      await chrome.storage.local.set({
        bridgeLastStatus: {
          message: "OpenClaw finished, but automatic ChatGPT submission failed: " + error.message +
            " Keep this tab open; the report is saved in the bridge popup.",
          kind: "error",
          deliveryError: error.message
        }
      });
    }
  } catch (error) {
    await chrome.storage.local.set({
      bridgeLastStatus: { message: "Bridge error: " + error.message, kind: "error" }
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "openclaw-bridge-submit-task") return false;
  (async () => {
    try {
      const task = String(message.task || "").trim();
      if (!task) throw new Error("The tagged task was empty.");
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) throw new Error("Could not identify the ChatGPT tab that sent this task.");
      const created = await apiRequest("/v1/tasks", {
        method: "POST",
        body: JSON.stringify({ task })
      });
      await chrome.storage.local.set({
        bridgeLastTaskId: created.task_id,
        bridgeLastStatus: { message: "Task accepted by the local bridge and queued for OpenClaw.", kind: "queued" }
      });
      runTask(created.task_id, task, tabId);
      sendResponse({ ok: true, taskId: created.task_id, status: created.status || "queued" });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true;
});
