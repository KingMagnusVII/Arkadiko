// Background content-script relay. Run/Stop controls live only in the extension popup.
(() => {
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  const START = "[[OPENCLAW_TASK]]";
  const END = "[[/OPENCLAW_TASK]]";
  const ACTIVE = new Set(["queued", "running"]);
  const handledMessages = new WeakSet();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let enabled = false;
  let stateReady = false;
  let currentTask = null;

  // Do not inspect messages until the saved Run/Stop state has been loaded.
  const stateLoaded = chrome.storage.local.get(["bridgeRunning"]).then(saved => {
    enabled = saved.bridgeRunning === true;
    stateReady = true;
  }).catch(error => {
    stateReady = true;
    console.error("[OpenClaw Bridge] Could not load session state:", error);
  });

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
    if (!node || node.getAttribute("data-message-author-role") !== "assistant") return null;
    const text = node.innerText || node.textContent || "";
    const start = text.lastIndexOf(START);
    if (start < 0) return null;
    const bodyStart = start + START.length;
    const end = text.indexOf(END, bodyStart);
    if (end < 0) return null;
    return text.slice(bodyStart, end).trim() || null;
  }

  function readComposerText(composer) {
    return (composer instanceof HTMLTextAreaElement ? composer.value : composer.innerText || "")
      .replace(/\u00a0/g, " ").trim();
  }

  async function postReport(report, taskState) {
    if (!enabled || !taskState.returnAllowed) return;
    const composer = document.querySelector('#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], textarea[data-testid="prompt-textarea"]');
    if (!composer) throw new Error("ChatGPT composer not found. Open the conversation and try again.");

    // Never destroy a user's unsent draft. Leave the report available in bridge status instead.
    if (readComposerText(composer)) {
      throw new Error("Your ChatGPT composer already contains a draft. It was left untouched; clear or send it before retrying the report.");
    }

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
    if (!enabled || handledMessages.has(node)) return;
    handledMessages.add(node);
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
        bridgeLastStatus: { message: "Handoff/report issue: " + error.message, kind: "error" }
      });
    } finally {
      if (currentTask === state) currentTask = null;
    }
  }

  function scanAssistant(node) {
    if (!(node instanceof HTMLElement)) return;
    const task = taskFromAssistant(node);
    if (task) runTask(task, node);
  }

  function scanMutationNode(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;

    // Streaming often mutates descendants inside an already-created assistant message.
    const ancestor = element.closest?.('[data-message-author-role="assistant"]');
    if (ancestor) scanAssistant(ancestor);

    if (element instanceof HTMLElement) {
      if (element.matches('[data-message-author-role="assistant"]')) scanAssistant(element);
      element.querySelectorAll?.('[data-message-author-role="assistant"]').forEach(scanAssistant);
    }
  }

  const observer = new MutationObserver(records => {
    if (!stateReady || !enabled) return;
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach(scanMutationNode);
        // Also inspect the target's containing assistant; text can be appended to existing nodes.
        scanMutationNode(record.target);
      } else if (record.type === "characterData") {
        scanMutationNode(record.target);
      }
    }
  });

  stateLoaded.then(() => {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    // Catch a message that appeared while the initial storage read was pending,
    // but only after confirming the user has armed the bridge.
    if (enabled) {
      document.querySelectorAll('[data-message-author-role="assistant"]').forEach(scanAssistant);
    }
  });
})();
