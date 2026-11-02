// READ-ONLY diagnostic content script.
// It observes ChatGPT assistant messages and saves their text for the popup.
// It deliberately contains no API calls and cannot submit work to OpenClaw.
(() => {
  // Prevent duplicate observers if the script is evaluated more than once in this tab.
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
  const CAPTURE_DELAY_MS = 500;
  const FALLBACK_SCAN_MS = 1200;
  const MAX_CAPTURED_MESSAGES = 10;

  // Weak collections associate state with DOM nodes without keeping removed nodes alive.
  const lastSeenText = new WeakMap();
  const pendingTimers = new WeakMap();

  let enabled = false;
  let stateReady = false;
  let captureLog = [];
  let mutationCount = 0;
  let scanCount = 0;
  let captureCount = 0;
  let lastMutationAt = null;

  // Keep a small diagnostic heartbeat in extension storage for the popup to display.
  async function saveDiagnostics(extra = {}) {
    const assistantCount = document.querySelectorAll(ASSISTANT_SELECTOR).length;
    const diagnostics = {
      updatedAt: new Date().toISOString(),
      page: location.href,
      readyState: document.readyState,
      contentScriptLoaded: true,
      stateReady,
      captureArmed: enabled,
      observerConnected: observerStarted,
      assistantCount,
      mutationCount,
      scanCount,
      captureCount,
      lastMutationAt,
      ...extra
    };

    try {
      await chrome.storage.local.set({ bridgeCaptureDiagnostics: diagnostics });
    } catch (error) {
      console.error("[OpenClaw Bridge diagnostic] Storage write failed:", error);
    }
  }

  // Read the user's capture switch and previous captures before scanning the page.
  chrome.storage.local.get(["bridgeRunning", "bridgeCaptureLog"]).then(saved => {
    enabled = saved.bridgeRunning === true;
    captureLog = Array.isArray(saved.bridgeCaptureLog) ? saved.bridgeCaptureLog : [];
    stateReady = true;

    saveDiagnostics({ lastEvent: "content-script-ready" });
    if (enabled) scanAllAssistantMessages("initial-scan");
  }).catch(error => {
    stateReady = true;
    console.error("[OpenClaw Bridge diagnostic] Could not read extension storage:", error);
    saveDiagnostics({ lastError: "Could not read extension storage: " + error.message });
  });

  // React immediately when Start capture or Stop is clicked in the popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.bridgeRunning) {
      enabled = changes.bridgeRunning.newValue === true;
      saveDiagnostics({ lastEvent: enabled ? "capture-enabled" : "capture-disabled" });
      if (enabled && stateReady) scanAllAssistantMessages("capture-enabled-scan");
    }

    if (changes.bridgeCaptureLog && Array.isArray(changes.bridgeCaptureLog.newValue)) {
      captureLog = changes.bridgeCaptureLog.newValue;
    }
  });

  // Read the rendered text of one assistant message, normalizing non-breaking spaces.
  function readAssistantText(node) {
    return (node.innerText || node.textContent || "")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  // Save one complete assistant message after a short quiet period.
  function scheduleCapture(node, source = "mutation") {
    if (!enabled || !stateReady || !(node instanceof HTMLElement)) return;
    if (node.getAttribute("data-message-author-role") !== "assistant") return;

    const currentText = readAssistantText(node);
    if (!currentText || lastSeenText.get(node) === currentText) return;
    lastSeenText.set(node, currentText);

    // Reset the timer while the message is still streaming.
    const oldTimer = pendingTimers.get(node);
    if (oldTimer) clearTimeout(oldTimer);

    const timer = setTimeout(async () => {
      if (!enabled) return;

      // Re-read at timer execution so the stored text includes the latest streamed content.
      const completeText = readAssistantText(node);
      if (!completeText) return;

      const messageId = node.getAttribute("data-message-id") || "";
      const entry = {
        capturedAt: new Date().toISOString(),
        page: location.href,
        messageId,
        characters: completeText.length,
        source,
        text: completeText
      };

      // Replace an earlier capture of the same identified message; keep the newest 10.
      captureLog = [
        entry,
        ...captureLog.filter(item => !messageId || item.messageId !== messageId)
      ].slice(0, MAX_CAPTURED_MESSAGES);

      try {
        await chrome.storage.local.set({
          bridgeCaptureLog: captureLog,
          bridgeLastStatus: {
            message: "Captured assistant message (" + entry.characters + " characters). Read-only; nothing sent to OpenClaw.",
            kind: "completed"
          }
        });
        captureCount += 1;
        await saveDiagnostics({
          lastEvent: "assistant-message-captured",
          lastCapturedCharacters: entry.characters,
          lastCapturedAt: entry.capturedAt,
          lastCapturedMessageId: messageId || "(not exposed by ChatGPT)"
        });
      } catch (error) {
        console.error("[OpenClaw Bridge diagnostic] Could not save captured message:", error);
        await saveDiagnostics({ lastError: "Could not save captured message: " + error.message });
      }
    }, CAPTURE_DELAY_MS);

    pendingTimers.set(node, timer);
  }

  // Scan all current assistant nodes. This also acts as a fallback if DOM mutations are missed.
  function scanAllAssistantMessages(source = "fallback-scan") {
    if (!enabled || !stateReady) return;
    scanCount += 1;
    const messages = document.querySelectorAll(ASSISTANT_SELECTOR);
    messages.forEach(node => scheduleCapture(node, source));
    saveDiagnostics({
      lastEvent: source,
      lastScanAt: new Date().toISOString(),
      assistantCount: messages.length
    });
  }

  // Resolve a changed text node or inserted element to its containing assistant message.
  function inspectMutation(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;

    const assistantAncestor = element.closest?.(ASSISTANT_SELECTOR);
    if (assistantAncestor) scheduleCapture(assistantAncestor, "mutation-observer");

    if (element instanceof HTMLElement) {
      if (element.matches(ASSISTANT_SELECTOR)) scheduleCapture(element, "mutation-observer");
      element.querySelectorAll?.(ASSISTANT_SELECTOR).forEach(message => {
        scheduleCapture(message, "mutation-observer");
      });
    }
  }

  // Observe inserted elements and streamed text changes inside assistant messages.
  const observer = new MutationObserver(records => {
    if (!stateReady || !enabled) return;
    mutationCount += records.length;
    lastMutationAt = new Date().toISOString();

    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach(inspectMutation);
        inspectMutation(record.target);
      } else if (record.type === "characterData") {
        inspectMutation(record.target);
      }
    }

    saveDiagnostics({ lastEvent: "mutation-observer-fired" });
  });

  let observerStarted = false;

  // Attach the observer once the document root exists.
  function startObserver() {
    if (!document.documentElement || observerStarted) return;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    observerStarted = true;
    saveDiagnostics({ lastEvent: "observer-attached" });
  }

  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }

  // Periodic scanning is a safety net for React/ChatGPT DOM updates the observer may miss.
  setInterval(() => {
    if (enabled && stateReady) scanAllAssistantMessages("periodic-fallback-scan");
  }, FALLBACK_SCAN_MS);
})();
