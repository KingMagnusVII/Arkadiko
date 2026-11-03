// User-armed ChatGPT -> local OpenClaw handoff.
// Only complete <OpenClaw>...</OpenClaw> blocks in new assistant turns are submitted.
(() => {
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  const SELECTOR = [
    '[data-message-author-role="assistant"]',
    '[data-conversation-role="assistant"]',
    'article[data-turn="assistant"]',
    'section[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-turn-key]:has([data-conversation-role="assistant"])',
    '[data-turn-key]:has([data-chatgpt-agent-turn-start])'
  ].join(',');

  const DEBOUNCE_MS = 500;
  const SCAN_INTERVAL_MS = 1200;
  const TAG_RE = /(?:<|&lt;)OpenClaw(?:>|&gt;)([\s\S]*?)(?:<\/|&lt;\/)OpenClaw(?:>|&gt;)/gi;

  let enabled = false;
  let stateReady = false;
  let pendingEnable = null;
  const seenNodes = new WeakSet();
  const historicalNodes = new WeakSet();
  const timers = new WeakMap();

  function normalize(node) {
    if (!(node instanceof Element)) return null;
    if (node.getAttribute("data-message-author-role") === "assistant") return node;
    if (node.getAttribute("data-conversation-role") === "assistant") return node;
    if (node.matches('[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"]')) return node;
    if (node.getAttribute("data-turn") === "assistant" ||
        node.matches('[data-testid^="conversation-turn-"],[data-turn-key]')) {
      return node.querySelector(
        '[data-message-author-role="assistant"],[data-conversation-role="assistant"],' +
        '[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"],' +
        '[data-chatgpt-agent-turn-start],[data-markdown-text-style="assistant-message"]'
      ) || (node.getAttribute("data-turn") === "assistant" ? node : null);
    }
    return node.querySelector?.(
      '[data-message-author-role="assistant"],[data-conversation-role="assistant"],' +
      '[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"]'
    ) || null;
  }

  function isAssistant(node, original = node) {
    if (!(node instanceof Element)) return false;
    const roleMatch =
      node.getAttribute("data-message-author-role") === "assistant" ||
      node.getAttribute("data-conversation-role") === "assistant" ||
      node.getAttribute("data-turn") === "assistant" ||
      node.matches('[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"],[data-chatgpt-agent-turn-start]');
    if (roleMatch) return true;
    if (original instanceof Element) {
      if (original.getAttribute("data-turn") === "assistant") return true;
      if (original.matches('[data-testid^="conversation-turn-"],[data-turn-key]')) {
        return Boolean(original.querySelector(
          '[data-message-author-role="assistant"],[data-conversation-role="assistant"],' +
          '[data-content-search-unit-key$=":assistant"],[data-chatgpt-search-unit-key$=":assistant"],' +
          '[data-chatgpt-agent-turn-start]'
        ));
      }
    }
    return false;
  }

  function getText(node) {
    if (!(node instanceof Element)) return "";
    const content = node.querySelector?.(
      '[data-message-author-role="assistant"] .markdown,' +
      '[data-message-author-role="assistant"] .prose,' +
      '[data-markdown-text-style="assistant-message"],' +
      '[data-conversation-role="assistant"] .markdown,' +
      '[data-conversation-role="assistant"] .prose,.markdown.prose'
    );
    const source = content || node;
    return (source.innerText || source.textContent || "").replace(/\\u00a0/g, " ").trim();
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
      if (node && isAssistant(node, element)) historicalNodes.add(node);
    }
  }

  async function reportStatus(message, kind = "neutral", extra = {}) {
    await chrome.storage.local.set({ bridgeLastStatus: { message, kind, ...extra } });
  }

  async function setEnabled(next) {
    if (!stateReady) {
      pendingEnable = next === true;
      return { ok: true, enabled: pendingEnable, waitingForInitialization: true };
    }
    enabled = next === true;
    if (enabled) seedHistory();
    await chrome.storage.local.set({ bridgeRunning: enabled });
    await reportStatus(
      enabled ? "Bridge open. Waiting for tagged assistant tasks." : "Bridge closed. New tasks will not be sent.",
      enabled ? "working" : "neutral"
    );
    return { ok: true, enabled };
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function findComposer() {
    return document.querySelector(
      '#prompt-textarea,[data-testid="prompt-textarea"],' +
      'textarea[placeholder],[contenteditable="true"].ProseMirror,' +
      '[contenteditable="true"][role="textbox"]'
    );
  }

  function composerText(composer) {
    if (!composer) return "";
    return "value" in composer ? String(composer.value || "") : String(composer.innerText || composer.textContent || "");
  }

  function findSendButton() {
    return document.querySelector(
      'button[data-testid="send-button"],' +
      'button[aria-label="Send prompt"],' +
      'button[aria-label^="Send"],' +
      'form button[type="submit"]:not([disabled])'
    );
  }

  async function waitFor(predicate, timeoutMs, failureMessage) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(120);
    }
    throw new Error(failureMessage);
  }

  function setComposerText(composer, text) {
    composer.focus();
    if ("value" in composer) {
      const prototype = Object.getPrototypeOf(composer);
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new Error("Could not access the ChatGPT composer value setter.");
      setter.call(composer, text);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Use the editor's native editing command so its framework receives a real
      // input event; do not replace React/Lexical-managed editor child nodes.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, text)) {
        throw new Error("ChatGPT rejected text insertion into its message editor.");
      }
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: text
      }));
    }
    const actual = composerText(composer).trim();
    if (!actual || (!actual.includes(text.slice(0, Math.min(80, text.length))) && actual.length < text.length * 0.7)) {
      throw new Error("ChatGPT did not accept the full execution report in its composer.");
    }
  }

  async function insertResultIntoChat(report) {
    if (!enabled) throw new Error("The bridge is closed; automatic report submission is disabled.");
    const text = String(report || "").trim();
    if (!text) throw new Error("OpenClaw returned an empty report.");
    const composer = await waitFor(
      findComposer, 8000,
      "Could not find ChatGPT's message editor. Keep the original ChatGPT tab open and try again."
    );

    // Never overwrite a draft the user has already started typing.
    if (composerText(composer).trim()) {
      throw new Error("ChatGPT's composer already contains a draft. The report was not sent to avoid overwriting it.");
    }

    setComposerText(composer, text);
    const send = await waitFor(() => {
      const button = findSendButton();
      return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null;
    }, 5000, "The report is in ChatGPT's composer, but its Send button never became available.");

    send.click();

    // Confirm the UI consumed the draft (usually it clears immediately and the
    // new user turn appears). A click alone is not proof of submission.
    await waitFor(() => {
      const current = findComposer();
      const cleared = current && !composerText(current).trim();
      const generating = Array.from(document.querySelectorAll("button")).some(button => {
        const label = (button.getAttribute("aria-label") || "").toLowerCase();
        const testId = (button.getAttribute("data-testid") || "").toLowerCase();
        return testId.includes("stop") || label.includes("stop generating") || label.includes("stop streaming");
      });
      return cleared || generating;
    }, 10000, "Clicked Send, but ChatGPT did not confirm that it accepted the report. Check the conversation before retrying to avoid duplicates.");

    await reportStatus("OpenClaw report submitted automatically to this ChatGPT conversation.", "completed");
    return { ok: true, submitted: true, confirmed: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "openclaw-bridge-open") {
      setEnabled(true).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "openclaw-bridge-close") {
      setEnabled(false).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "openclaw-bridge-insert-result") {
      insertResultIntoChat(message.report).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  chrome.storage.local.get(["bridgeRunning"]).then(saved => {
    enabled = saved.bridgeRunning === true;
    stateReady = true;
    if (enabled) seedHistory();
    if (pendingEnable !== null) {
      const requested = pendingEnable;
      pendingEnable = null;
      setEnabled(requested).catch(error => reportStatus("Bridge state error: " + error.message, "error"));
    }
  }).catch(error => {
    stateReady = true;
    reportStatus("Could not initialize bridge state: " + error.message, "error");
    if (pendingEnable !== null) {
      const requested = pendingEnable;
      pendingEnable = null;
      setEnabled(requested).catch(() => {});
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bridgeRunning && stateReady) {
      enabled = changes.bridgeRunning.newValue === true;
      if (enabled) seedHistory();
    }
  });

  function schedule(node) {
    if (!enabled || !stateReady || !(node instanceof Element)) return;
    const captureNode = normalize(node);
    if (!captureNode || (!isAssistant(captureNode, captureNode) && !isAssistant(node, node)) ||
        historicalNodes.has(captureNode) || seenNodes.has(captureNode)) return;
    const previous = timers.get(captureNode);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(async () => {
      if (!enabled || historicalNodes.has(captureNode) || seenNodes.has(captureNode)) return;
      const completeText = getText(captureNode);
      if (!completeText) return;
      const tasks = extractTasks(completeText);
      seenNodes.add(captureNode);
      if (!tasks.length) {
        await reportStatus("New assistant message captured; no <OpenClaw> task tag found.", "completed");
        return;
      }
      for (const task of tasks) {
        const queuedAt = new Date().toISOString();
        await chrome.storage.local.set({
          bridgeQueuedTask: { task, queuedAt, sourceText: completeText },
          bridgeLastResult: null,
          bridgeLastStatus: { message: "Detected <OpenClaw> task tag. Sending to local OpenClaw.", kind: "queued" }
        });
        try {
          const response = await chrome.runtime.sendMessage({
            type: "openclaw-bridge-submit-task", task, pageUrl: location.href
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
  if (document.documentElement) observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["data-turn", "data-testid", "data-message-author-role", "data-conversation-role", "data-turn-key"]
  });
  setInterval(() => {
    if (enabled && stateReady) document.querySelectorAll(SELECTOR).forEach(schedule);
  }, SCAN_INTERVAL_MS);
})();
