// OpenClaw Chrome Control — Background Service Worker
// Manages WebSocket relay connection, command routing, screenshots, and tab management.

const CONFIG = {
  relayUrl: 'ws://localhost:9224',
  gatewayUrl: 'http://localhost:18789',
  gatewayToken: null,
  authToken: null,
};

let ws = null;
let connectionState = 'disconnected'; // disconnected | connecting | connected | error
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 1000;
let keepaliveInterval = null;

// ── Load settings from storage ────────────────────────────────────────────

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['relayUrl', 'gatewayUrl', 'gatewayToken', 'authToken'], (result) => {
      if (result.relayUrl) CONFIG.relayUrl = result.relayUrl;
      if (result.gatewayUrl) CONFIG.gatewayUrl = result.gatewayUrl;
      if (result.gatewayToken) CONFIG.gatewayToken = result.gatewayToken;
      if (result.authToken) CONFIG.authToken = result.authToken;
      resolve();
    });
  });
}

// ── Connection State ─────────────────────────────────────────────────────

function setConnectionState(state) {
  connectionState = state;
  const colors = { disconnected: '#666', connecting: '#f90', connected: '#0c0', error: '#c00' };
  const labels = { disconnected: '', connecting: '...', connected: '✓', error: '!' };
  chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#666' });
  chrome.action.setBadgeText({ text: labels[state] || '' });
}

// ── WebSocket Connection ─────────────────────────────────────────────────

function connectRelay() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  setConnectionState('connecting');
  console.log(`[occc] Connecting to relay: ${CONFIG.relayUrl}`);

  try {
    ws = new WebSocket(CONFIG.relayUrl);
  } catch (err) {
    console.error('[occc] WebSocket constructor error:', err);
    setConnectionState('error');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[occc] Connected to relay');
    setConnectionState('connected');
    reconnectAttempts = 0;

    // Identify ourselves
    ws.send(JSON.stringify({
      type: 'identify',
      role: 'extension',
      auth: CONFIG.authToken || undefined,
    }));

    // Send status
    ws.send(JSON.stringify({ type: 'status', extensionConnected: true }));

    // Start keepalive
    startKeepalive();
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'command') {
      handleCommand(msg);
    }
  };

  ws.onclose = () => {
    console.log('[occc] Disconnected from relay');
    setConnectionState('disconnected');
    stopKeepalive();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[occc] WebSocket error:', err);
    setConnectionState('error');
  };
}

function disconnectRelay() {
  if (ws) {
    ws.close();
    ws = null;
  }
  clearTimeout(reconnectTimer);
  stopKeepalive();
  setConnectionState('disconnected');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  console.log(`[occc] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, delay);
}

// ── Keepalive ─────────────────────────────────────────────────────────────

function startKeepalive() {
  stopKeepalive();
  keepaliveInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 20000); // Ping every 20s to keep service worker alive
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

// ── Command Handler ──────────────────────────────────────────────────────

async function handleCommand(msg) {
  const { id, action, target, value, options } = msg;

  try {
    switch (action) {
      case 'screenshot':
        await handleScreenshot(id);
        break;

      case 'list_tabs':
        await handleListTabs(id);
        break;

      case 'switch_tab':
        await handleSwitchTab(id, value);
        break;

      case 'close_tab':
        await handleCloseTab(id, value);
        break;

      case 'navigate':
        await handleNavigate(id, value);
        break;

      default:
        // Forward to content script in active tab
        await forwardToContentScript(id, action, target, value, options);
        break;
    }
  } catch (err) {
    sendResponse(id, { error: err.message });
  }
}

// ── Screenshot ───────────────────────────────────────────────────────────

async function handleScreenshot(id) {
  try {
    const tab = await getActiveTab();
    if (!tab) {
      sendResponse(id, { error: 'No active tab' });
      return;
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    // Strip data:image/png;base64, prefix
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    sendResponse(id, { screenshot: base64 });
  } catch (err) {
    sendResponse(id, { error: err.message });
  }
}

// ── Tab Management ───────────────────────────────────────────────────────

async function handleListTabs(id) {
  const tabs = await chrome.tabs.query({});
  const tabList = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
  }));
  sendResponse(id, { tabs: tabList });
}

async function handleSwitchTab(id, tabId) {
  const tid = typeof tabId === 'string' ? parseInt(tabId, 10) : tabId;
  await chrome.tabs.update(tid, { active: true });
  const tab = await chrome.tabs.get(tid);
  await chrome.windows.update(tab.windowId, { focused: true });
  sendResponse(id, { ok: true, tab: { id: tab.id, title: tab.title, url: tab.url } });
}

async function handleCloseTab(id, tabId) {
  const tid = typeof tabId === 'string' ? parseInt(tabId, 10) : tabId;
  await chrome.tabs.remove(tid);
  sendResponse(id, { ok: true });
}

async function handleNavigate(id, url) {
  const tab = await getActiveTab();
  if (!tab) {
    sendResponse(id, { error: 'No active tab' });
    return;
  }
  await chrome.tabs.update(tab.id, { url });
  sendResponse(id, { ok: true, url });
}

// ── Forward to Content Script ────────────────────────────────────────────

async function forwardToContentScript(id, action, target, value, options) {
  const tab = await getActiveTab();
  if (!tab) {
    sendResponse(id, { error: 'No active tab' });
    return;
  }

  // Check if the tab URL is accessible
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url === 'about:blank')) {
    sendResponse(id, { error: `Cannot interact with ${tab.url}` });
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      action,
      target,
      value,
      options,
    });
    sendResponse(id, response);
  } catch (err) {
    sendResponse(id, { error: `Content script not loaded: ${err.message}` });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function sendResponse(id, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'response', id, payload }));
  }
}

// ── Message Handlers (from popup, options, etc.) ─────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getConnectionState') {
    sendResponse({ state: connectionState });
    return;
  }

  if (msg.type === 'connect') {
    connectRelay();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'disconnect') {
    disconnectRelay();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'getConfig') {
    sendResponse({ relayUrl: CONFIG.relayUrl, gatewayUrl: CONFIG.gatewayUrl });
    return;
  }

  if (msg.type === 'test_gateway') {
    // Test gateway via relay HTTP endpoint (avoids CORS)
    const relayWs = CONFIG.relayUrl;
    const relayHttp = relayWs.replace(/^ws/, 'http').replace(/:\d+$/, ':9225');
    fetch(relayHttp + '/gateway-test')
      .then((res) => {
        if (!res.ok) throw new Error('Relay not reachable');
        return res.json();
      })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (msg.type === 'settings_updated') {
    loadSettings().then(() => {
      // Reconnect with new settings if currently connected
      if (connectionState === 'connected' || connectionState === 'connecting') {
        disconnectRelay();
        connectRelay();
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

// ── Startup ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[occc] Extension installed');
  setConnectionState('disconnected');
});

// Auto-connect on startup
loadSettings().then(() => {
  setConnectionState('disconnected');
  connectRelay();
});
