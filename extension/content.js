// Temporary read-only capture mode: inspect assistant messages without sending anything to OpenClaw.
(() => {
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  const seenText = new WeakMap();
  const pending = new WeakMap();
  let enabled = false;
  let stateReady = false;
  let captureLog = [];

  chrome.storage.local.get(["bridgeRunning", "bridgeCaptureLog"]).then(saved => {
    enabled = saved.bridgeRunning === true;
    captureLog = Array.isArray(saved.bridgeCaptureLog) ? saved.bridgeCaptureLog : [];
    stateReady = true;
    if (enabled) {
      document.querySelectorAll('[data-message-author-role="assistant"]').forEach(scheduleCapture);
    }
  }).catch(error => {
    stateReady = true;
    console.error("[OpenClaw Bridge capture]", error);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.bridgeRunning) {
      enabled = changes.bridgeRunning.newValue === true;
      if (enabled && stateReady) {
        document.querySelectorAll('[data-message-author-role="assistant"]').forEach(scheduleCapture);
      }
    }
    if (changes.bridgeCaptureLog && Array.isArray(changes.bridgeCaptureLog.newValue)) {
      captureLog = changes.bridgeCaptureLog.newValue;
    }
  });

  function snapshot(node) {
    return (node.innerText || node.textContent || "").replace(/\u00a0/g, " ").trim();
  }

  function scheduleCapture(node) {
    if (!enabled || !stateReady || !(node instanceof HTMLElement)) return;
    if (node.getAttribute("data-message-author-role") !== "assistant") return;

    const text = snapshot(node);
    if (!text || seenText.get(node) === text) return;
    seenText.set(node, text);

    const oldTimer = pending.get(node);
    if (oldTimer) clearTimeout(oldTimer);

    // Wait briefly for a streamed assistant message to settle, then save its full text.
    const timer = setTimeout(async () => {
      if (!enabled) return;
      const finalText = snapshot(node);
      if (!finalText) return;
      const entry = {
        capturedAt: new Date().toISOString(),
        page: location.href,
        messageId: node.getAttribute("data-message-id") || "",
        characters: finalText.length,
        text: finalText
      };
      captureLog = [entry, ...captureLog.filter(item => item.messageId !== entry.messageId || !entry.messageId)].slice(0, 10);
      try {
        await chrome.storage.local.set({
          bridgeCaptureLog: captureLog,
          bridgeLastStatus: {
            message: "Captured assistant message (" + entry.characters + " characters). Read-only trial: nothing was sent to OpenClaw.",
            kind: "working"
          }
        });
      } catch (error) {
        console.error("[OpenClaw Bridge capture] Could not save captured message:", error);
      }
    }, 700);
    pending.set(node, timer);
  }

  function inspectMutation(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;

    const ancestor = element.closest?.('[data-message-author-role="assistant"]');
    if (ancestor) scheduleCapture(ancestor);

    if (element instanceof HTMLElement) {
      if (element.matches('[data-message-author-role="assistant"]')) scheduleCapture(element);
      element.querySelectorAll?.('[data-message-author-role="assistant"]').forEach(scheduleCapture);
    }
  }

  const observer = new MutationObserver(records => {
    if (!stateReady || !enabled) return;
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach(inspectMutation);
        inspectMutation(record.target);
      } else if (record.type === "characterData") {
        inspectMutation(record.target);
      }
    }
  });

  const startObserver = () => {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.documentElement) startObserver();
  else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
})();
