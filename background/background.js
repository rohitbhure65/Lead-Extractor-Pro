// Map Leadify - Background Service Worker
// Manages extraction session state, relays progress, handles tab operations
importScripts('../env.js');

// ── Session State ──────────────────────────────────────────────────────────────
// Kept in-memory AND written to chrome.storage.local so the popup can
// re-hydrate whenever it reopens.
let extractionSession = {
  isExtracting: false,
  sessionId: null,
  startTime: null,
  totalFound: 0,
  totalSaved: 0,
  totalFailed: 0,
  percent: 0,
  statusText: 'Ready to scan',
  stopped: false,
  completed: false,
  tabId: null,
  errors: []
};

const SESSION_KEY = 'extractionSession';

// Persist session to chrome.storage.local so popup can read it on open
async function persistSession() {
  await chrome.storage.local.set({ [SESSION_KEY]: extractionSession });
}

async function resetSession() {
  extractionSession = {
    isExtracting: false,
    sessionId: null,
    startTime: null,
    totalFound: 0,
    totalSaved: 0,
    totalFailed: 0,
    percent: 0,
    statusText: 'Ready to scan',
    stopped: false,
    completed: false,
    tabId: null,
    errors: []
  };
  await persistSession();
}

// Broadcast session state to any open popup windows
function broadcastSession(extra = {}) {
  chrome.runtime.sendMessage({
    action: 'sessionUpdate',
    session: { ...extractionSession, ...extra }
  }).catch(() => {
    // Popup may not be open – silently ignore
  });
}

// ── Message Listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;

  // ── Extraction progress relayed from content script ──────────────────────
  if (action === 'extractionProgress') {
    handleExtractionProgress(message, sender);
    sendResponse({ ok: true });
    return false;
  }

  // ── Popup queries current session state on open ──────────────────────────
  if (action === 'getExtractionState') {
    sendResponse({ session: extractionSession });
    return false;
  }

  // ── Popup notifies BG that extraction started ────────────────────────────
  if (action === 'extractionStarted') {
    extractionSession = {
      isExtracting: true,
      sessionId: message.sessionId,
      startTime: Date.now(),
      totalFound: 0,
      totalSaved: 0,
      totalFailed: 0,
      percent: 0,
      statusText: 'Starting extraction…',
      stopped: false,
      completed: false,
      tabId: message.tabId || null,
      errors: []
    };
    persistSession();
    sendResponse({ ok: true });
    return false;
  }

  // ── Popup notifies BG that extraction was stopped ─────────────────────────
  if (action === 'extractionStopped') {
    extractionSession.isExtracting = false;
    extractionSession.stopped = true;
    extractionSession.statusText = message.statusText || 'Stopped by user';
    persistSession();
    sendResponse({ ok: true });
    return false;
  }

  // ── Popup notifies BG that extraction completed ───────────────────────────
  if (action === 'extractionCompleted') {
    extractionSession.isExtracting = false;
    extractionSession.completed = true;
    extractionSession.percent = 100;
    extractionSession.statusText = message.statusText || 'Extraction complete';
    extractionSession.totalSaved = message.totalSaved ?? extractionSession.totalSaved;
    persistSession();
    sendResponse({ ok: true });
    return false;
  }

  // ── Reset session ─────────────────────────────────────────────────────────
  if (action === 'resetExtractionState') {
    resetSession().then(() => sendResponse({ ok: true }));
    return true;
  }

  // ── URL-based extraction (background tab) ────────────────────────────────
  if (action === 'extractFromUrl') {
    extractFromUrl(message.url, message.keywords)
      .then(leads => sendResponse({ leads }))
      .catch(error => sendResponse({ error: error.message, leads: [] }));
    return true;
  }

  // ── Open WhatsApp and send message ────────────────────────────────────────
  if (action === 'openWhatsAppAndSend') {
    openWhatsAppAndSend(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ error: error.message || 'Failed to open WhatsApp' }));
    return true;
  }

  // ── Relay saveLeadsRequest from content script to popup ──────────────────
  if (action === 'saveLeadRequest') {
    chrome.runtime.sendMessage({
      action: 'saveLeadRequest',
      lead: message.lead
    }).catch(() => { });
    sendResponse({ relayed: true });
    return false;
  }
  // ── Licensing & API Key ────────────────────────────────────────────────────
  if (action === 'validateLicense') {
    validateLicense(message.apiKey)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ valid: false, error: error.message }));
    return true;
  }

  if (action === 'getLicenseState') {
    getLicenseState().then(state => sendResponse(state));
    return true;
  }

  if (action === 'logoutLicense') {
    logoutLicense().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

// ── Licensing Logic ──────────────────────────────────────────────────────────
const API_URL = `${ENV.APP_URL}/api`;
let heartbeatInterval = null;

async function validateLicense(apiKey) {
  try {
    const res = await fetch(`${API_URL}/verify-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Validation failed');

    await chrome.storage.local.set({
      licenseState: {
        valid: true,
        sessionToken: apiKey, // Keep apiKey as token
        expiresAt: data.expiresAt
      }
    });

    startHeartbeat();
    return data;
  } catch (error) {
    throw error;
  }
}

async function getLicenseState() {
  const data = await chrome.storage.local.get('licenseState');
  const state = data.licenseState || { valid: false };
  if (state.valid && new Date(state.expiresAt) < new Date()) {
    state.valid = false;
    await logoutLicense();
  }
  return state;
}

async function logoutLicense() {
  stopHeartbeat();
  await chrome.storage.local.remove('licenseState');
}

async function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(async () => {
    const state = await getLicenseState();
    if (!state.valid || !state.sessionToken) return stopHeartbeat();

    try {
      const res = await fetch(`${API_URL}/verify-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: state.sessionToken })
      });
      if (!res.ok) {
        // Session invalid or expired
        await logoutLicense();
        broadcastSession({ licenseRevoked: true });
      }
    } catch (e) {
      // Network error, ignore temporarily
    }
  }, 4 * 60 * 1000); // 4 minutes
}

function stopHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

// Start heartbeat on load if licensed
getLicenseState().then(state => {
  if (state.valid) startHeartbeat();
});

// ── Handle progress updates from content script ───────────────────────────────
function handleExtractionProgress(message, sender) {
  if (!extractionSession.isExtracting) return;
  if (message.sessionId && message.sessionId !== extractionSession.sessionId) return;

  // Update session state
  if (typeof message.totalFound === 'number') extractionSession.totalFound = message.totalFound;
  if (typeof message.totalSaved === 'number') extractionSession.totalSaved = message.totalSaved;
  if (typeof message.percent === 'number') extractionSession.percent = Math.max(0, Math.min(100, message.percent));
  if (message.statusText) extractionSession.statusText = message.statusText;
  if (message.error) {
    extractionSession.totalFailed = (extractionSession.totalFailed || 0) + 1;
    extractionSession.errors = [...(extractionSession.errors || []).slice(-9), message.error];
  }

  if (message.complete) {
    extractionSession.isExtracting = false;
    extractionSession.completed = true;
    extractionSession.percent = 100;
  }

  persistSession();
  broadcastSession();
}

// ── URL-based extraction (opens tab in background) ────────────────────────────
async function extractFromUrl(url, keywords = []) {
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    await waitForTabStatus(tab.id, 'complete');
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extract',
      keywords,
      source: url
    });
    await chrome.tabs.remove(tab.id).catch(() => { });
    return response?.leads || [];
  } catch (error) {
    console.error('[BG] URL extraction error:', error);
    return [];
  }
}

// ── Wait for a tab to reach a given status ───────────────────────────────────
function waitForTabStatus(tabId, status = 'complete', timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === status) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Open WhatsApp tab and send message ────────────────────────────────────────
async function openWhatsAppAndSend(url) {
  if (!url) throw new Error('WhatsApp URL is missing');

  // Open the wa.me redirect URL
  const tab = await chrome.tabs.create({ url, active: true });

  // wa.me redirects to web.whatsapp.com – wait for that to fully load
  await waitForWhatsAppReady(tab.id);

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'autoSendWhatsApp' });
  } catch (error) {
    // Silently allow – WhatsApp was opened, auto-send may have minor issues
    console.warn('[BG] WhatsApp auto-send warning:', error.message);
  }
}

// ── Wait until the WhatsApp chat page is fully ready ─────────────────────────
async function waitForWhatsAppReady(tabId, timeoutMs = 45000) {
  const start = Date.now();

  // Phase 1: wait for any redirect to settle (URL contains whatsapp.com)
  await new Promise((resolve) => {
    function listener(updatedTabId, info, updatedTab) {
      if (updatedTabId !== tabId) return;
      if (
        info.status === 'complete' &&
        updatedTab.url &&
        updatedTab.url.includes('whatsapp.com')
      ) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Resolve after timeout to avoid hanging
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
  });

  // Phase 2: extra buffer for SPA to render
  await delay(2500);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Extension installed ───────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('[BG] Map Leadify installed');
    await resetSession();
  }
});
