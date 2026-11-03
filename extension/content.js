// READ-ONLY diagnostic content script.
// It observes ChatGPT assistant turns and saves their text for the popup.
// It deliberately contains no API calls and cannot submit work to OpenClaw.
(() => {
  // Prevent duplicate observers if the script is evaluated more than once in this tab.
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  // ChatGPT's current DOM uses assistant role attributes inside conversation turns.
  // We also support the turn wrapper because some current renderers expose the role
  // on article/section[data-turn] instead of the inner message element.
  const ASSISTANT_SELECTOR = [
    '[data-message-author-role="assistant"]',
    'article[data-turn="assistant"]',
    'section[data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])'
  ].join(',');
  const CAPTURE_DELAY_MS = 500;
  const FALLBACK_SCAN_MS = 1200;
  const MAX_CAPTURED_MESSAGES = 10;

  const lastSeenText = new WeakMap();
  const pendingTimers = new WeakMap();

  let enabled = false;
  let stateReady = false;
  let captureLog = [];
  let mutationCount = 0;
  let scanCount = 0;
  let captureCount = 0;
  let lastMutationAt = null;

  async function saveDiagnostics(extra = {}) {
    const assistantNodes = Array.from(document.querySelectorAll(ASSISTANT_SELECTOR));
    const diagnostics = {
      updatedAt: new Date().toISOString(),
      page: location.href,
      readyState: document.readyState,
      contentScriptLoaded: true,
      stateReady,
      captureArmed: enabled,
      observerConnected: observerStarted,
      assistantCount: assistantNodes.length,
      assistantRoleCount: document.querySelectorAll('[data-message-author-role="assistant"]').length,
      assistantTurnCount: document.querySelectorAll('[data-turn="assistant"]').length,
      conversationTurnCount: document.querySelectorAll('[data-testid^="conversation-turn-"]').length,
      articleTurnCount: document.querySelectorAll('article[data-turn]').length,
      mutationCount,
      scanCount,
      captureCount,
      lastMutationAt,
      ...extra
    };

    try {
      await chrome.storage.local.set({ bridgeCaptureDiagnostics: diagnostics });
    } catch (error) {
      console.error('[OpenClaw Bridge diagnostic] Storage write failed:', error);
    }
  }

  chrome.storage.local.get(['bridgeRunning', 'bridgeCaptureLog']).then(saved => {
    enabled = saved.bridgeRunning === true;
    captureLog = Array.isArray(saved.bridgeCaptureLog) ? saved.bridgeCaptureLog : [];
    stateReady = true;

    saveDiagnostics({ lastEvent: 'content-script-ready' });
    if (enabled) scanAllAssistantMessages('initial-scan');
  }).catch(error => {
    stateReady = true;
    console.error('[OpenClaw Bridge diagnostic] Could not read extension storage:', error);
    saveDiagnostics({ lastError: 'Could not read extension storage: ' + error.message });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.bridgeRunning) {
      enabled = changes.bridgeRunning.newValue === true;
      saveDiagnostics({ lastEvent: enabled ? 'capture-enabled' : 'capture-disabled' });
      if (enabled && stateReady) scanAllAssistantMessages('capture-enabled-scan');
    }

    if (changes.bridgeCaptureLog && Array.isArray(changes.bridgeCaptureLog.newValue)) {
      captureLog = changes.bridgeCaptureLog.newValue;
    }
  });

  // Prefer the actual message content element when available, but fall back to the
  // conversation-turn wrapper so the diagnostic works across current renderers.
  function getCaptureText(node) {
    const content = node.querySelector?.(
      '[data-message-author-role="assistant"] .markdown,' +
      '[data-message-author-role="assistant"] .prose,' +
      '[data-message-author-role="assistant"],' +
      '.markdown.prose'
    );
    const source = content || node;
    return (source.innerText || source.textContent || '')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function isAssistantNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.getAttribute('data-message-author-role') === 'assistant') return true;
    if (node.getAttribute('data-turn') === 'assistant') return true;
    if (node.matches('[data-testid^="conversation-turn-"]')) {
      return Boolean(node.querySelector('[data-message-author-role="assistant"]'));
    }
    return false;
  }

  function normalizeCaptureNode(node) {
    if (!(node instanceof Element)) return null;
    if (node.getAttribute('data-message-author-role') === 'assistant') return node;
    if (node.getAttribute('data-turn') === 'assistant') {
      return node.querySelector('[data-message-author-role="assistant"]') || node;
    }
    const roleNode = node.querySelector?.('[data-message-author-role="assistant"]');
    return roleNode || null;
  }

  function scheduleCapture(node, source = 'mutation') {
    if (!enabled || !stateReady || !(node instanceof Element)) return;

    const captureNode = normalizeCaptureNode(node);
    if (!captureNode || !isAssistantNode(captureNode) && !isAssistantNode(node)) return;

    const currentText = getCaptureText(captureNode);
    if (!currentText || lastSeenText.get(captureNode) === currentText) return;
    lastSeenText.set(captureNode, currentText);

    const oldTimer = pendingTimers.get(captureNode);
    if (oldTimer) clearTimeout(oldTimer);

    const timer = setTimeout(async () => {
      if (!enabled) return;

      const completeText = getCaptureText(captureNode);
      if (!completeText) return;

      const messageId =
        captureNode.getAttribute('data-message-id') ||
        node.getAttribute('data-turn-id') ||
        node.getAttribute('data-testid') || '';

      const entry = {
        capturedAt: new Date().toISOString(),
        page: location.href,
        messageId,
        characters: completeText.length,
        source,
        text: completeText
      };

      captureLog = [
        entry,
        ...captureLog.filter(item => !messageId || item.messageId !== messageId)
      ].slice(0, MAX_CAPTURED_MESSAGES);

      try {
        await chrome.storage.local.set({
          bridgeCaptureLog: captureLog,
          bridgeLastStatus: {
            message: 'Captured assistant message (' + entry.characters + ' characters). Read-only; nothing sent to OpenClaw.',
            kind: 'completed'
          }
        });
        captureCount += 1;
        await saveDiagnostics({
          lastEvent: 'assistant-message-captured',
          lastCapturedCharacters: entry.characters,
          lastCapturedAt: entry.capturedAt,
          lastCapturedMessageId: messageId || '(not exposed by ChatGPT)'
        });
      } catch (error) {
        console.error('[OpenClaw Bridge diagnostic] Could not save captured message:', error);
        await saveDiagnostics({ lastError: 'Could not save captured message: ' + error.message });
      }
    }, CAPTURE_DELAY_MS);

    pendingTimers.set(captureNode, timer);
  }

  function scanAllAssistantMessages(source = 'fallback-scan') {
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

  function inspectMutation(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;

    const assistantAncestor = element.closest?.(ASSISTANT_SELECTOR);
    if (assistantAncestor) scheduleCapture(assistantAncestor, 'mutation-observer');

    if (element instanceof Element) {
      if (element.matches(ASSISTANT_SELECTOR)) scheduleCapture(element, 'mutation-observer');
      element.querySelectorAll?.(ASSISTANT_SELECTOR).forEach(message => {
        scheduleCapture(message, 'mutation-observer');
      });
    }
  }

  const observer = new MutationObserver(records => {
    if (!stateReady || !enabled) return;
    mutationCount += records.length;
    lastMutationAt = new Date().toISOString();

    for (const record of records) {
      if (record.type === 'childList') {
        record.addedNodes.forEach(inspectMutation);
        inspectMutation(record.target);
      } else if (record.type === 'characterData') {
        inspectMutation(record.target);
      }
    }

    saveDiagnostics({ lastEvent: 'mutation-observer-fired' });
  });

  let observerStarted = false;

  function startObserver() {
    if (!document.documentElement || observerStarted) return;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    observerStarted = true;
    saveDiagnostics({ lastEvent: 'observer-attached' });
  }

  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  }

  setInterval(() => {
    if (enabled && stateReady) scanAllAssistantMessages('periodic-fallback-scan');
  }, FALLBACK_SCAN_MS);
})();
