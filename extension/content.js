// READ-ONLY diagnostic content script.
// It observes only assistant messages that appear after capture is armed.
// <OpenClaw>...</OpenClaw> detection remains read-only; nothing is sent to OpenClaw.
(() => {
  if (window.__openClawBridgeLoaded) return;
  window.__openClawBridgeLoaded = true;

  const ASSISTANT_SELECTOR = [
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

  // Wait for streaming to finish and the assistant DOM to settle before capturing.
  const CAPTURE_DELAY_MS = 1500;
  const GENERATION_RECHECK_MS = 500;
  const FALLBACK_SCAN_MS = 1200;
  const MAX_CAPTURED_MESSAGES = 10;
  const OPENCLAW_TAG_RE = /<OpenClaw>([\s\S]*?)<\/OpenClaw>/i;

  const lastSeenText = new WeakMap();
  const pendingTimers = new WeakMap();
  // Count each assistant DOM message once, even if ChatGPT updates its DOM repeatedly.
  let capturedNodes = new WeakSet();
  // Nodes already present when capture starts are historical and are never captured.
  let preExistingNodes = new WeakSet();

  let enabled = false;
  let stateReady = false;
  let captureLog = [];
  let mutationCount = 0;
  let scanCount = 0;
  let captureCount = 0;
  let tagCount = 0;
  let lastMutationAt = null;
  let observerStarted = false;

  function queryAll(selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (error) {
      console.error('[OpenClaw Bridge diagnostic] Selector error:', selector, error);
      return [];
    }
  }

  function findOpenClawTasks(text) {
    const tasks = [];
    const matcher = new RegExp(OPENCLAW_TAG_RE.source, 'gi');
    let match;
    while ((match = matcher.exec(String(text || ''))) !== null) {
      const task = (match[1] || '').trim();
      if (task) tasks.push(task);
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
    return tasks;
  }

  async function saveDiagnostics(extra = {}) {
    const assistantNodes = queryAll(ASSISTANT_SELECTOR);
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
      contentSearchAssistantCount: document.querySelectorAll('[data-content-search-unit-key$=":assistant"]').length,
      chatgptSearchAssistantCount: document.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"]').length,
      turnKeyCount: document.querySelectorAll('[data-turn-key]').length,
      conversationRoleAssistantCount: document.querySelectorAll('[data-conversation-role="assistant"]').length,
      agentTurnStartCount: document.querySelectorAll('[data-chatgpt-agent-turn-start]').length,
      mutationCount,
      scanCount,
      captureCount,
      tagCount,
      lastMutationAt,
      ...extra
    };
    try {
      await chrome.storage.local.set({ bridgeCaptureDiagnostics: diagnostics });
    } catch (error) {
      console.error('[OpenClaw Bridge diagnostic] Storage write failed:', error);
    }
  }

  function normalizeCaptureNode(node) {
    if (!(node instanceof Element)) return null;
    if (node.getAttribute('data-message-author-role') === 'assistant') return node;
    if (node.getAttribute('data-conversation-role') === 'assistant') return node;
    if (node.getAttribute('data-turn') === 'assistant') {
      return node.querySelector('[data-message-author-role="assistant"], [data-conversation-role="assistant"], [data-markdown-text-style="assistant-message"]') || node;
    }
    if (node.matches('[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]')) return node;
    if (node.matches('[data-turn-key]')) {
      return node.querySelector('[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-conversation-role="assistant"], [data-chatgpt-agent-turn-start], [data-markdown-text-style="assistant-message"]') || node;
    }
    return node.querySelector?.('[data-message-author-role="assistant"], [data-conversation-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]') || null;
  }

  function isAssistantNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.getAttribute('data-message-author-role') === 'assistant') return true;
    if (node.getAttribute('data-conversation-role') === 'assistant') return true;
    if (node.getAttribute('data-turn') === 'assistant') return true;
    if (node.matches('[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]')) return true;
    if (node.matches('[data-turn-key]')) {
      return Boolean(node.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]'));
    }
    if (node.matches('[data-testid^="conversation-turn-"]')) return Boolean(node.querySelector('[data-message-author-role="assistant"]'));
    return false;
  }

  function isAssistantGenerationActive() {
    // ChatGPT exposes a Stop control while an assistant turn is still streaming.
    // Keep waiting while it is present, even if the text temporarily stops changing.
    return Boolean(document.querySelector(
      'button[data-testid="stop-button"],' +
      'button[aria-label*="Stop generating" i],' +
      'button[aria-label*="Stop streaming" i]'
    ));
  }

  function getCaptureText(node) {
    if (!(node instanceof Element)) return '';
    const content = node.querySelector?.(
      '[data-message-author-role="assistant"] .markdown,' +
      '[data-message-author-role="assistant"] .prose,' +
      '[data-markdown-text-style="assistant-message"],' +
      '[data-conversation-role="assistant"] .markdown,' +
      '[data-conversation-role="assistant"] .prose,' +
      '.markdown.prose'
    );
    const source = content || node;
    return (source.innerText || source.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  // Take a snapshot of the conversation at the instant capture is armed.
  // Existing assistant turns are marked historical, not queued for capture.
  function seedExistingAssistantMessages() {
    preExistingNodes = new WeakSet();
    const nodes = queryAll(ASSISTANT_SELECTOR);
    for (const node of nodes) {
      const captureNode = normalizeCaptureNode(node);
      if (!captureNode) continue;
      preExistingNodes.add(captureNode);
      lastSeenText.set(captureNode, getCaptureText(captureNode));
      const timer = pendingTimers.get(captureNode);
      if (timer) clearTimeout(timer);
    }
    return nodes.length;
  }

  async function setCaptureState(nextEnabled, source) {
    const wasEnabled = enabled;
    enabled = nextEnabled === true;

    if (enabled && !wasEnabled) {
      // Start a fresh capture session: discard prior diagnostic captures and
      // establish a baseline so the initial scan cannot count old messages.
      captureLog = [];
      captureCount = 0;
      tagCount = 0;
      capturedNodes = new WeakSet();
      await chrome.storage.local.set({ bridgeCaptureLog: [] });
      const historicalCount = seedExistingAssistantMessages();
      await chrome.storage.local.set({
        bridgeRunning: true,
        bridgeLastStatus: {
          message: 'Capture armed. Ignoring ' + historicalCount + ' existing assistant messages; waiting for new messages.',
          kind: 'working'
        }
      });
      await saveDiagnostics({
        lastEvent: source || 'capture-enabled',
        historicalMessagesIgnored: historicalCount
      });
      return { ok: true, captureArmed: true, historicalMessagesIgnored: historicalCount };
    }

    await chrome.storage.local.set({
      bridgeRunning: enabled,
      bridgeLastStatus: {
        message: enabled ? 'Capture already armed. Existing messages remain ignored.' : 'Capture stopped. No messages are being inspected.',
        kind: enabled ? 'working' : 'neutral'
      }
    });
    await saveDiagnostics({ lastEvent: source || (enabled ? 'capture-enabled' : 'capture-disabled') });
    return { ok: true, captureArmed: enabled };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type) return false;
    if (message.type === 'openclaw-bridge-start-capture') {
      setCaptureState(true, 'capture-enabled-by-popup').then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'openclaw-bridge-stop-capture') {
      setCaptureState(false, 'capture-disabled-by-popup').then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === 'openclaw-bridge-get-diagnostics') {
      saveDiagnostics({ lastEvent: 'diagnostics-requested' }).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  chrome.storage.local.get(['bridgeRunning', 'bridgeCaptureLog']).then(saved => {
    enabled = saved.bridgeRunning === true;
    // Do not restore old captures into the active session's counter.
    captureLog = [];
    stateReady = true;
    if (enabled) {
      const historicalCount = seedExistingAssistantMessages();
      saveDiagnostics({ lastEvent: 'content-script-ready-baseline', historicalMessagesIgnored: historicalCount });
    } else {
      saveDiagnostics({ lastEvent: 'content-script-ready' });
    }
  }).catch(error => {
    stateReady = true;
    console.error('[OpenClaw Bridge diagnostic] Could not read extension storage:', error);
    saveDiagnostics({ lastError: 'Could not read extension storage: ' + error.message });
  });

  chrome.storage.onChanged.addListener(changes => {
    if (changes.bridgeRunning) {
      enabled = changes.bridgeRunning.newValue === true;
      saveDiagnostics({ lastEvent: enabled ? 'capture-enabled-storage' : 'capture-disabled-storage' });
      if (!enabled) preExistingNodes = new WeakSet();
    }
    if (changes.bridgeCaptureLog && Array.isArray(changes.bridgeCaptureLog.newValue)) {
      captureLog = changes.bridgeCaptureLog.newValue;
    }
  });

  function scheduleCapture(node, source = 'mutation') {
    if (!enabled || !stateReady || !(node instanceof Element)) return;
    const captureNode = normalizeCaptureNode(node);
    // Only accept a node that is itself identified as an assistant message.
    // Do not accept a surrounding conversation/user-turn container merely
    // because it happens to contain an assistant descendant.
    if (!captureNode || !isAssistantNode(captureNode)) return;
    if (preExistingNodes.has(captureNode) || capturedNodes.has(captureNode)) return;

    const currentText = getCaptureText(captureNode);
    if (!currentText || lastSeenText.get(captureNode) === currentText) return;
    lastSeenText.set(captureNode, currentText);

    const oldTimer = pendingTimers.get(captureNode);
    if (oldTimer) clearTimeout(oldTimer);

    const timer = setTimeout(async () => {
      if (!enabled || preExistingNodes.has(captureNode)) return;
      const completeText = getCaptureText(captureNode);
      if (!completeText || capturedNodes.has(captureNode)) return;

      // A quiet DOM interval alone is not enough: streaming can pause briefly.
      // If ChatGPT still shows its Stop control, keep polling until generation ends.
      if (isAssistantGenerationActive()) {
        const retryTimer = setTimeout(async () => {
          if (!enabled || preExistingNodes.has(captureNode) || capturedNodes.has(captureNode)) return;
          const latestText = getCaptureText(captureNode);
          if (!latestText) return;
          if (isAssistantGenerationActive()) {
            pendingTimers.set(captureNode, setTimeout(() => {
              // Re-enter the normal debounce path after another short wait.
              lastSeenText.set(captureNode, '');
              scheduleCapture(captureNode, source);
            }, GENERATION_RECHECK_MS));
            return;
          }
          lastSeenText.set(captureNode, '');
          scheduleCapture(captureNode, source);
        }, GENERATION_RECHECK_MS);
        pendingTimers.set(captureNode, retryTimer);
        return;
      }

      // Mark only after the assistant turn is complete, before awaiting storage.
      capturedNodes.add(captureNode);
      const openClawTasks = findOpenClawTasks(completeText);
      if (openClawTasks.length) tagCount += openClawTasks.length;

      const messageId =
        captureNode.getAttribute('data-message-id') ||
        captureNode.getAttribute('data-turn-id') ||
        node.getAttribute('data-turn-id') ||
        node.getAttribute('data-turn-key') ||
        node.getAttribute('data-testid') || '';

      const entry = {
        capturedAt: new Date().toISOString(),
        page: location.href,
        messageId,
        characters: completeText.length,
        source,
        openClawTagDetected: openClawTasks.length > 0,
        openClawTaskCount: openClawTasks.length,
        text: completeText
      };

      captureLog = [entry, ...captureLog.filter(item => messageId ? item.messageId !== messageId : true)].slice(0, MAX_CAPTURED_MESSAGES);
      try {
        await chrome.storage.local.set({
          bridgeCaptureLog: captureLog,
          bridgeLastStatus: {
            message: openClawTasks.length
              ? 'Detected <OpenClaw> task tag (' + openClawTasks.length + ' task' + (openClawTasks.length === 1 ? '' : 's') + '). Read-only; nothing sent to OpenClaw.'
              : 'Captured new assistant message (' + entry.characters + ' characters). Read-only; nothing sent to OpenClaw.',
            kind: openClawTasks.length ? 'queued' : 'completed'
          }
        });
        captureCount += 1;
        await saveDiagnostics({
          lastEvent: openClawTasks.length ? 'openclaw-tag-detected' : 'assistant-message-captured',
          lastCapturedCharacters: entry.characters,
          lastCapturedAt: entry.capturedAt,
          lastCapturedMessageId: messageId || '(not exposed by ChatGPT)',
          lastOpenClawTagDetected: openClawTasks.length > 0,
          lastOpenClawTaskCount: openClawTasks.length
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
    const messages = queryAll(ASSISTANT_SELECTOR);
    messages.forEach(node => scheduleCapture(node, source));
    saveDiagnostics({ lastEvent: source, lastScanAt: new Date().toISOString(), assistantCount: messages.length });
  }

  function inspectMutation(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return;
    const assistantAncestor = element.closest?.(ASSISTANT_SELECTOR);
    if (assistantAncestor) scheduleCapture(assistantAncestor, 'mutation-observer');
    if (element instanceof Element) {
      if (element.matches(ASSISTANT_SELECTOR)) scheduleCapture(element, 'mutation-observer');
      element.querySelectorAll?.(ASSISTANT_SELECTOR).forEach(message => scheduleCapture(message, 'mutation-observer'));
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
      } else if (record.type === 'characterData' || record.type === 'attributes') {
        inspectMutation(record.target);
      }
    }
    saveDiagnostics({ lastEvent: 'mutation-observer-fired' });
  });

  function startObserver() {
    if (!document.documentElement || observerStarted) return;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-turn-key', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key',
        'data-conversation-role', 'data-message-author-role', 'data-message-id',
        'data-turn-id', 'data-testid'
      ]
    });
    observerStarted = true;
    saveDiagnostics({ lastEvent: 'observer-attached' });
  }

  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  setInterval(() => {
    if (enabled && stateReady) scanAllAssistantMessages('periodic-fallback-scan');
  }, FALLBACK_SCAN_MS);
})();
