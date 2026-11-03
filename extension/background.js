// Arkadiko's Manifest V3 service worker coordinates the extension-to-API task lifecycle.
// It submits tagged tasks, polls the local API, stores status, and returns reports to ChatGPT.

// Local API fallback used until the user changes the endpoint in the extension popup.
const DEFAULT_ENDPOINT = "http://127.0.0.1:8765";
// Poll every two seconds so the popup and originating ChatGPT tab receive updates promptly.
const POLL_INTERVAL_MS = 2000;
// Stop polling after roughly five and a half minutes to avoid an unbounded background loop.
const MAX_POLL_ATTEMPTS = 165;

// Read the saved API URL and token; never make an authenticated request without a token.
async function getConnection() {
  const saved = await chrome.storage.local.get(["endpoint", "token"]);
  const endpoint = (saved.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
  const token = (saved.token || "").trim();
  if (!token) throw new Error("Add your local Bridge token in the extension popup first.");
  return { endpoint, token };
}

// Shared HTTP helper: attaches Bearer authentication, parses JSON, and surfaces API errors.
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

// Promise-based pause used between result-status requests.
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Convert the API task record into a readable report for the popup and ChatGPT conversation.
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

// Poll one accepted task until it completes/fails or the polling deadline is reached.
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

    // Save the complete report before attempting delivery so it remains available if ChatGPT is unavailable.
    const report = formatReport(task, result);
    await chrome.storage.local.set({
      bridgeLastResult: { taskId, task, result, report, receivedAt: new Date().toISOString() },
      bridgeLastStatus: {
        message: "OpenClaw finished. Submitting its report automatically to ChatGPT.",
        kind: "working"
      }
    });

    // Delivery is a separate step: execution can succeed even if the browser cannot submit the report.
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
    // Store unexpected API/polling failures in the popup rather than losing the task's visible status.
    await chrome.storage.local.set({
      bridgeLastStatus: { message: "Bridge error: " + error.message, kind: "error" }
    });
  }
}

// Receive task handoffs from content.js, submit them to FastAPI, and start polling in the background.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "openclaw-bridge-submit-task") return false;
  (async () => {
    try {
      const task = String(message.task || "").trim();
      if (!task) throw new Error("The tagged task was empty.");
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) throw new Error("Could not identify the ChatGPT tab that sent this task.");

      // FastAPI responds with a task ID immediately; OpenClaw execution happens asynchronously on the API side.
      const created = await apiRequest("/v1/tasks", {
        method: "POST",
        body: JSON.stringify({ task })
      });
      await chrome.storage.local.set({
        bridgeLastTaskId: created.task_id,
        bridgeLastStatus: { message: "Task accepted by the local bridge and queued for OpenClaw.", kind: "queued" }
      });

      // Do not await the polling loop here; acknowledge the handoff while it runs.
      runTask(created.task_id, task, tabId);
      sendResponse({ ok: true, taskId: created.task_id, status: created.status || "queued" });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true; // Keep the message channel open until the async response is sent.
});
