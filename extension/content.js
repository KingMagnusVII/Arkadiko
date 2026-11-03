// User-armed ChatGPT -> local OpenClaw handoff.
// Only complete <OpenClaw>...</OpenClaw> blocks in new assistant turns are submitted.
(() => {
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  const SELECTOR = [
    '[data-message-author-role="assistant"]',
    'article[data-turn="assistant"]',
    'section[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-turn-key]:has([data-conversation-role="assistant"])',
    '[data-turn-key]:has([data-chatgpt-agent-turn-start])'
  ].join(',');

  const DEBOUNCE_MS = 1400;
  const STABILITY_INTERVAL_MS = 650;
  const REQUIRED_STABLE_CHECKS = 3;
  const SCAN_INTERVAL_MS = 1200;
  const TAG_RE = /<OpenClaw>([\\s\\S]*?)<\\/OpenClaw>/gi;

  let enabled = false;
  let stateReady = false;
  const seenNodes = new WeakSet();
  const historicalNodes = new WeakSet();
  const timers = new WeakMap();

  const getText = node => {
    const content = node.querySelector?.(
      '[data-message-author-role="assistant"] .markdown,' +
      '[data-message-author-role="assistant"] .prose,' +
      '[data-markdown-text-style="assistant-message"],' +
      '[data-conversation-role="assistant"] .markdown,' +
      '[data-conversation-role="assistant"] .prose,' +
      '.markdown.prose'
    );
    const source = content || node;
    return (source.innerText || source.textContent || "").replace(/\\u00a0/g, " ").trim();
  };

  function normalize(node) {
    if (!(node instanceof Element)) return null;
    if (node.matches('[data-message-author-role="assistant"],[data-conversation-role="assistant"]')) return node;
    if (node.matches('[data-turn="assistant"]')) {
      return node.querySelector('[data-message-author-role="assistant"],[data-conversation-role="assistant"],[data-markdown-text-style="assistant-message"]') || node;
    }
    if (node.matches('[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"]')) return node;
    return node.querySelector?.('[data-message-author-role="assistant"],[data-conversation-role="assistant"],[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"]') || null;
  }

  function isAssistant(node) {
    return node instanceof Element && (
      node.getAttribute("data-message-author-role") === "assistant" ||
      node.getAttribute("data-conversation-role") === "assistant" ||
      node.getAttribute("data-turn") === "assistant" ||
      node.matches('[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"]')
    );
  }

  function generationActive() {
    const controls = Array.from(document.querySelectorAll('button'));
    return controls.some(button => {
      const label = (button.getAttribute("aria-label") || "").toLowerCase();
      const testId = (button.getAttribute("data-testid") || "").toLowerCase();
      const text = (button.innerText || button.textContent || "").trim().toLowerCase();
      return testId.includes("stop") || label.includes("stop generating") ||
        label.includes("stop streaming") || text === "stop";
    });
  }

  function extractTasks(text) {
    const tasks = [];
    const matcher = new RegExp(TAG_RE.source, "gi");
    let match;
    while ((match = matcher.exec(text)) !== null) {
      const task = (match[1] || "").trim();
      if (task) tasks.push(task);
    }
    return tasks;
  }

  function seedHistory() {
    for (const element of document.querySelectorAll(SELECTOR)) {
      const node = normalize(element);
      if (node) historicalNodes.add(node);
    }
  }

  async function reportStatus(message, kind = "neutral", extra = {}) {
    await chrome.storage.local.set({
      bridgeLastStatus: { message, kind, ...extra }
    });
  }

  function setEnabled(next) {
    enabled = next === true;
    if (enabled) seedHistory();
    chrome.storage.local.set({ bridgeRunning: enabled });
    reportStatus(
      enabled ? "Bridge open. Waiting for tagged assistant tasks." : "Bridge closed. New tasks will not be sent.",
      enabled ? "working" : "neutral"
    );
    return { ok: true, enabled };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "openclaw-bridge-open") {
      sendResponse(setEnabled(true));
      return false;
    }
    if (message?.type === "openclaw-bridge-close") {
      sendResponse(setEnabled(false));
      return false;
    }
    if (message?.type === "openclaw-bridge-insert-result") {
      insertResultIntoChat(message.report).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  async function insertResultIntoChat(report) {
    const composer = document.querySelector('#prompt-textarea,[contenteditable="true"][data-testid="prompt-textarea"],[contenteditable="true"].ProseMirror');
    if (!composer) throw new Error("Could not find the ChatGPT message composer.");
    composer.focus();
    const text = String(report || "");
    if ("value" in composer) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else {
      composer.replaceChildren(document.createTextNode(text));
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    const send = document.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"]');
    if (!send || send.disabled) throw new Error("Result was placed in the composer, but ChatGPT's Send button was unavailable.");
    send.click();
    return { ok: true, submitted: true };
  }

  chrome.storage.local.get(["bridgeRunning"]).then(saved => {
    enabled = saved.bridgeRunning === true;
    stateReady = true;
    if (enabled) seedHistory();
  }).catch(() => { stateReady = true; });

  function schedule(node) {
    if (!enabled || !stateReady || !(node instanceof Element)) return;
    const captureNode = normalize(node);
    if (!captureNode || !isAssistant(captureNode) || historicalNodes.has(captureNode) || seenNodes.has(captureNode)) return;
    const previous = timers.get(captureNode);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(async () => {
      if (!enabled || historicalNodes.has(captureNode) || seenNodes.has(captureNode)) return;
      let lastText = getText(captureNode);
      if (!lastText) return;
      let stableChecks = 0;
      while (enabled && stableChecks < REQUIRED_STABLE_CHECKS) {
        await new Promise(resolve => setTimeout(resolve, STABILITY_INTERVAL_MS));
        if (!enabled) return;
        const currentText = getText(captureNode);
        if (generationActive() || currentText !== lastText) {
          lastText = currentText;
          stableChecks = 0;
        } else {
          stableChecks += 1;
        }
      }
      if (!enabled || generationActive()) return;
      const completeText = getText(captureNode);
      if (!completeText || seenNodes.has(captureNode)) return;
      const tasks = extractTasks(completeText);
      seenNodes.add(captureNode);
      if (!tasks.length) return;

      // The popup always retains the newest complete tagged task as the queued item.
      for (const task of tasks) {
        const queuedAt = new Date().toISOString();
        await chrome.storage.local.set({
          bridgeQueuedTask: { task, queuedAt, sourceText: completeText },
          bridgeLastStatus: { message: "Tagged task received and queued for OpenClaw.", kind: "queued" }
        });
        try {
          const response = await chrome.runtime.sendMessage({
            type: "openclaw-bridge-submit-task",
            task,
            pageUrl: location.href
          });
          if (!response?.ok) throw new Error(response?.error || "Task submission failed.");
        } catch (error) {
          await reportStatus("Could not send task to OpenClaw: " + error.message, "error");
        }
      }
    }, DEBOUNCE_MS);
    timers.set(captureNode, timer);
  }

  function inspect(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!element) return;
    const ancestor = element.closest?.(SELECTOR);
    if (ancestor) schedule(ancestor);
    if (element.matches?.(SELECTOR)) schedule(element);
    element.querySelectorAll?.(SELECTOR).forEach(schedule);
  }

  const observer = new MutationObserver(records => {
    if (!enabled || !stateReady) return;
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(inspect);
      inspect(record.target);
    }
  });

  function attachObserver() {
    if (document.documentElement) observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["data-turn", "data-testid", "data-message-author-role", "data-conversation-role"]
    });
  }
  attachObserver();
  setInterval(() => {
    if (enabled && stateReady) document.querySelectorAll(SELECTOR).forEach(schedule);
  }, SCAN_INTERVAL_MS);
})();
