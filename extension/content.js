// Background content-script relay. Run/Stop controls live only in the extension popup.
(() => {
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  const START = "[[OPENCLAW_TASK]]";
  const END = "[[/OPENCLAW_TASK]]";
  const ACTIVE = new Set(["queued", "running"]);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let enabled = false;
  let currentTask = null;

  async function loadState() {
    const saved = await chrome.storage.local.get(["bridgeRunning"]);
    enabled = saved.bridgeRunning === true;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bridgeRunning) {
      enabled = changes.bridgeRunning.newValue === true;
      if (!enabled && currentTask) currentTask.returnAllowed = false;
    }
  });

  async function settings() {
    const data = await chrome.storage.local.get(["endpoint", "token"]);
    return {
      endpoint: (data.endpoint || "http://127.0.0.1:8765").trim().replace(/\/$/, ""),
      token: (data.token || "").trim()
    };
  }

  function taskFromAssistant(node) {
    if (node.getAttribute("data-message-author-role") !== "assistant") return null;
    const text = node.innerText || "";
    const start = text.lastIndexOf(START);
    if (start < 0) return null;
    const bodyStart = start + START.length;
    const end = text.indexOf(END, bodyStart);
    if (end < 0) return null;
    return text.slice(bodyStart, end).trim() || null;
  }

  async function postReport(report, taskState) {
    if (!enabled || !taskState.returnAllowed) return;
    const composer = document.querySelector('#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], textarea[data-testid="prompt-textarea"]');
    if (!composer) throw new Error("ChatGPT composer not found. Open the conversation and try again.");

    const message = "OpenClaw execution report (automatic bridge return):\n\n" + report;
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(composer, message);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
    } else {
      composer.replaceChildren();
      const paragraph = document.createElement("p");
      paragraph.textContent = message;
      composer.appendChild(paragraph);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
    }

    await sleep(350);
    if (!enabled || !taskState.returnAllowed) return;
    const send = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]');
    if (!send || send.disabled) throw new Error("Send button unavailable; report remains in the composer.");
    send.click();
  }

  async function runTask(task, node) {
    if (!enabled || node.dataset.openclawBridgeHandled === "true") return;
    node.dataset.openclawBridgeHandled = "true";
    const state = { returnAllowed: true };
    currentTask = state;

    try {
      const config = await settings();
      if (!config.token) throw new Error("Bridge token missing. Configure it in the extension popup.");
      const headers = { "Content-Type": "application/json", Authorization: "Bearer " + config.token };
      if (!enabled || !state.returnAllowed) return;

      const submission = await fetch(config.endpoint + "/v1/tasks", {
        method: "POST",
        headers,
        body: JSON.stringify({ task })
      });
      const created = await submission.json();
      if (!submission.ok) throw new Error(created.detail || submission.statusText);

      await chrome.storage.local.set({
        bridgeLastStatus: { message: "OpenClaw is processing task " + created.task_id + ".", kind: "working" }
      });

      let result;
      const deadline = Date.now() + 330000;
      do {
        await sleep(1800);
        if (!enabled || !state.returnAllowed) return;
        const response = await fetch(config.endpoint + "/v1/tasks/" + encodeURIComponent(created.task_id), { headers });
        result = await response.json();
        if (!response.ok) throw new Error(result.detail || response.statusText);
      } while (ACTIVE.has(result.status) && Date.now() < deadline);

      if (ACTIVE.has(result.status)) throw new Error("Timed out waiting for OpenClaw.");
      const report = [
        "Task ID: " + result.task_id,
        "Status: " + result.status,
        "Exit code: " + (result.exit_code ?? "not available"),
        result.error ? "Error: " + result.error : "",
        "STDOUT:",
        result.stdout || "(empty)",
        "STDERR:",
        result.stderr || "(empty)"
      ].filter(Boolean).join("\n");

      await postReport(report, state);
      if (enabled && state.returnAllowed) {
        await chrome.storage.local.set({
          bridgeLastStatus: { message: "Last task " + result.status + ". Report returned to ChatGPT.", kind: result.status }
        });
      }
    } catch (error) {
      console.error("[OpenClaw Bridge]", error);
      await chrome.storage.local.set({
        bridgeLastStatus: { message: "Handoff failed: " + error.message, kind: "error" }
      });
      if (enabled && state.returnAllowed) {
        try {
          await postReport("Automatic OpenClaw handoff failed:\n" + error.message, state);
        } catch (returnError) {
          console.error("[OpenClaw Bridge] Could not return error:", returnError);
        }
      }
    } finally {
      if (currentTask === state) currentTask = null;
    }
  }

  function scanNode(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches('[data-message-author-role="assistant"]')) {
      const task = taskFromAssistant(node);
      if (task) runTask(task, node);
    }
    node.querySelectorAll?.('[data-message-author-role="assistant"]').forEach(scanNode);
  }

  const observer = new MutationObserver(records => {
    if (!enabled) return;
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(scanNode);
      else if (record.type === "characterData") scanNode(record.target.parentElement);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  loadState();
})();
