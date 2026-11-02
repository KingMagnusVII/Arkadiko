// Adds a small Run/Stop switch to ChatGPT. Automation is OFF by default.
// Only assistant messages with the explicit [[OPENCLAW_TASK]] marker are eligible.
(() => {
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  const START = "[[OPENCLAW_TASK]]";
  const END = "[[/OPENCLAW_TASK]]";
  const ACTIVE = new Set(["queued", "running"]);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let enabled = false;
  let currentTask = null;

  const style = document.createElement("style");
  style.textContent = `
    #openclaw-bridge-toggle {
      position: fixed; right: 22px; bottom: 104px; z-index: 999999;
      border: 1px solid #777; border-radius: 999px; padding: 8px 14px;
      background: #171717; color: #eee; font: 600 12px/1.2 system-ui,sans-serif;
      box-shadow: 0 3px 14px #0007; cursor: pointer;
    }
    #openclaw-bridge-toggle[data-state="running"] { border-color: #aaa; background: #292929; }
    #openclaw-bridge-toggle:focus-visible { outline: 2px solid white; outline-offset: 3px; }
  `;
  document.documentElement.appendChild(style);

  const toggle = document.createElement("button");
  toggle.id = "openclaw-bridge-toggle";
  toggle.type = "button";
  toggle.textContent = "Run OpenClaw";
  toggle.dataset.state = "stopped";
  toggle.setAttribute("aria-pressed", "false");
  document.documentElement.appendChild(toggle);

  async function loadState() {
    const data = await chrome.storage.local.get(["bridgeRunning"]);
    enabled = data.bridgeRunning === true;
    paint();
  }
  function paint() {
    toggle.textContent = enabled ? "Stop OpenClaw" : "Run OpenClaw";
    toggle.dataset.state = enabled ? "running" : "stopped";
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.title = enabled
      ? "Automation is armed. Click to stop new handoffs and report submissions."
      : "Automation is stopped. Click to arm explicit OpenClaw task handoffs.";
  }

  toggle.addEventListener("click", async () => {
    enabled = !enabled;
    await chrome.storage.local.set({ bridgeRunning: enabled });
    paint();
    if (enabled) scan(document.documentElement);
    else if (currentTask) currentTask.returnAllowed = false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bridgeRunning) {
      enabled = changes.bridgeRunning.newValue === true;
      if (!enabled && currentTask) currentTask.returnAllowed = false;
      paint();
      if (enabled) scan(document.documentElement);
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
      const p = document.createElement("p");
      p.textContent = message;
      composer.appendChild(p);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
    }
    await sleep(300);
    if (!enabled || !taskState.returnAllowed) return;
    const send = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]');
    if (!send || send.disabled) throw new Error("Send button unavailable; report was placed in the composer but not submitted.");
    send.click();
  }

  async function runTask(task, node) {
    if (!enabled || node.dataset.openclawBridgeHandled === "true") return;
    node.dataset.openclawBridgeHandled = "true";
    const state = { returnAllowed: true };
    currentTask = state;
    try {
      const config = await settings();
      if (!config.token) throw new Error("Bridge token missing. Configure it from the extension popup.");
      const headers = { "Content-Type": "application/json", Authorization: "Bearer " + config.token };
      const submitted = await fetch(config.endpoint + "/v1/tasks", {
        method: "POST", headers, body: JSON.stringify({ task })
      });
      const created = await submitted.json();
      if (!submitted.ok) throw new Error(created.detail || submitted.statusText);

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
    } catch (error) {
      console.error("[OpenClaw Bridge]", error);
      if (enabled && state.returnAllowed) {
        try { await postReport("Automatic OpenClaw handoff failed:\n" + error.message, state); }
        catch (returnError) { console.error("[OpenClaw Bridge] Could not return error:", returnError); }
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
  function scan(root) {
    if (root instanceof HTMLElement) scanNode(root);
    root.querySelectorAll?.('[data-message-author-role="assistant"]').forEach(scanNode);
  }

  const observer = new MutationObserver(records => {
    if (!enabled) return;
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(scan);
      else if (record.type === "characterData") scanNode(record.target.parentElement);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  loadState();
})();
