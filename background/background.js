// Map Leadify - Background Service Worker
// Manages extraction session state, relays progress, handles tab operations
if (typeof importScripts === 'function' && typeof ENV === 'undefined') {
  importScripts('../env.js');
}

const APP_URL = (typeof ENV !== 'undefined' && ENV.APP_URL) ? ENV.APP_URL : 'http://localhost:3000';

/**
 * @typedef {Object} ExtractionSession
 * @property {boolean} isExtracting
 * @property {string | null} sessionId
 * @property {number | null} startTime
 * @property {number} totalFound
 * @property {number} totalSaved
 * @property {number} totalFailed
 * @property {number} percent
 * @property {string} statusText
 * @property {boolean} stopped
 * @property {boolean} completed
 * @property {number | null} tabId
 * @property {string[]} errors
 */

/**
 * @typedef {Object} LicenseState
 * @property {boolean} [valid]
 * @property {string | null} [sessionToken]
 * @property {string} [accessType]
 * @property {boolean} [upgradedFromTrial]
 * @property {string | null} [email]
 * @property {number | null} [durationDays]
 * @property {string | null} [startDate]
 * @property {string | null} [expiresAt]
 * @property {number | null} [remainingMs]
 * @property {any} [trial]
 * @property {any} [subscription]
 * @property {boolean} [expired]
 * @property {boolean} [revoked]
 * @property {boolean} [deleted]
 * @property {boolean} [networkError]
 * @property {boolean} [canActivate]
 * @property {string | null} [statusCode]
 * @property {string | null} [code]
 * @property {string} [status]
 * @property {string | null} [error]
 * @property {number} [lastCheckedAt]
 */

/** @typedef {Error & { details?: Record<string, any> }} DetailedError */

/**
 * @param {string} message
 * @param {Record<string, any>} [details]
 * @returns {DetailedError}
 */
function createDetailedError(message, details) {
  /** @type {DetailedError} */
  const err = new Error(message);
  if (details !== undefined) {
    err.details = details;
  }
  return err;
}

/**
 * @param {unknown} error
 * @param {string} [fallback]
 * @returns {string}
 */
function getErrorMessage(error, fallback = 'Unknown error') {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

/**
 * @param {unknown} error
 * @returns {Record<string, any> | undefined}
 */
function getErrorDetails(error) {
  if (error && typeof error === 'object' && 'details' in error && error.details && typeof error.details === 'object') {
    return /** @type {Record<string, any>} */ (error.details);
  }
  return undefined;
}

// ── Session State ──────────────────────────────────────────────────────────────
// Kept in-memory AND written to chrome.storage.local so the popup can
// re-hydrate whenever it reopens.
/** @type {ExtractionSession} */
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
/**
 * @param {Record<string, any>} [extra]
 */
function broadcastSession(extra = {}) {
  chrome.runtime.sendMessage({
    action: 'sessionUpdate',
    session: { ...extractionSession, ...extra }
  }).catch(() => {
    // Popup may not be open – silently ignore
  });
}

// ── Message Listener ──────────────────────────────────────────────────────────
/**
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 * @param {(response?: any) => void} sendResponse
 * @returns {boolean}
 */
function handleBackgroundMessage(message, sender, sendResponse) {
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
    verifyLicenseNow({ broadcastOnFailure: true })
      .then(async (access) => {
        if (!access.valid) {
          sendResponse({ ok: false, error: access.error || 'Access denied', licenseState: access });
          return;
        }
        extractionSession = {
          isExtracting: true,
          sessionId: message.sessionId || null,
          startTime: Date.now(),
          totalFound: 0,
          totalSaved: 0,
          totalFailed: 0,
          percent: 0,
          statusText: 'Starting extraction…',
          stopped: false,
          completed: false,
          tabId: typeof message.tabId === 'number' ? message.tabId : null,
          errors: []
        };
        await persistSession();
        sendResponse({ ok: true, access });
      })
      .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error, 'Access check failed') }));
    return true;
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
      .catch((error) => sendResponse({ error: getErrorMessage(error, 'URL extraction failed'), leads: [] }));
    return true;
  }

  // ── Open WhatsApp and send message ────────────────────────────────────────
  if (action === 'openWhatsAppAndSend') {
    openWhatsAppAndSend(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: getErrorMessage(error, 'Failed to open WhatsApp') }));
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
  // ── Licensing & Trial Management ────────────────────────────────────────────
  if (action === 'validateLicense') {
    validateLicense(message.apiKey, {
      email: message.email,
      activateIfUnusedTrial: message.activateIfUnusedTrial !== false
    })
      .then(result => sendResponse({ valid: true, ...result }))
      .catch(async (error) => {
        const details = getErrorDetails(error) || {};
        const messageText = getErrorMessage(error, 'Validation failed');
        const errorMsg = messageText.toLowerCase();
        let status = 'error';
        if (details.code === 'TRIAL_NOT_ACTIVATED') {
          status = 'trial_not_activated';
        } else if (details.expired || details.code === 'TRIAL_EXPIRED' || details.code === 'SUBSCRIPTION_EXPIRED' || errorMsg.includes('expired') || errorMsg.includes('over')) {
          status = 'expired';
          const prev = (await chrome.storage.local.get('licenseState'))?.licenseState || {};
          await chrome.storage.local.set({
            licenseState: {
              ...prev,
              valid: false,
              expired: true,
              revoked: false,
              sessionToken: message.apiKey || prev.sessionToken || null,
              accessType: details.accessType || prev.accessType || 'paid',
              statusCode: details.code || 'EXPIRED',
              expiresAt: details.expiresAt || prev.expiresAt || null,
              error: messageText,
              lastCheckedAt: Date.now()
            }
          });
        } else if (details.code === 'KEY_REVOKED' || details.code === 'SUBSCRIPTION_REVOKED' || errorMsg.includes('revoked')) {
          status = 'revoked';
          await logoutLicense();
        } else {
          status = 'deleted';
          await logoutLicense();
        }
        sendResponse({
          valid: false,
          status,
          code: details.code || null,
          accessType: details.accessType || null,
          expired: status === 'expired',
          revoked: status === 'revoked',
          canActivate: Boolean(details.canActivate),
          expiresAt: details.expiresAt || null,
          error: messageText
        });
      });
    return true;
  }

  if (action === 'activateTrial') {
    activateTrial({ trialKey: message.trialKey, email: message.email })
      .then(result => sendResponse({ valid: true, ...result }))
      .catch((error) => {
        const details = getErrorDetails(error) || {};
        const expired = details.code === 'TRIAL_EXPIRED' || Boolean(details.expired);
        sendResponse({
          valid: false,
          status: expired ? 'expired' : 'error',
          code: details.code || null,
          accessType: 'trial',
          expired,
          expiresAt: details.expiresAt || null,
          error: getErrorMessage(error, 'Trial activation failed')
        });
      });
    return true;
  }

  if (action === 'verifyLicenseNow') {
    verifyLicenseNow({ broadcastOnFailure: message.broadcast !== false })
      .then(result => sendResponse(result))
      .catch((error) => sendResponse({ valid: false, status: 'error', error: getErrorMessage(error, 'Verification failed') }));
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
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

// ── Licensing & Trial Enforcement Logic ─────────────────────────────────────
const API_URL = `${APP_URL}/api`;
const LICENSE_ALARM_NAME = 'mapLeadifyLicenseCheck';
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatInterval = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let expiryTimeout = null;

/**
 * @param {string} apiKey
 * @param {Record<string, any>} data
 * @returns {LicenseState}
 */
function buildLicenseStatePayload(apiKey, data) {
  return {
    valid: true,
    sessionToken: apiKey,
    accessType: data.accessType || 'paid',
    upgradedFromTrial: Boolean(data.upgradedFromTrial),
    email: data.email || null,
    durationDays: data.durationDays || null,
    startDate: data.startDate || null,
    expiresAt: data.expiresAt || null,
    remainingMs: data.remainingMs ?? null,
    trial: data.trial || null,
    subscription: data.subscription || null,
    expired: false,
    revoked: false,
    statusCode: null,
    error: null,
    lastCheckedAt: Date.now()
  };
}

/**
 * @param {string} apiKey
 * @param {{ email?: string, activateIfUnusedTrial?: boolean }} [options]
 * @returns {Promise<LicenseState & Record<string, any>>}
 */
async function validateLicense(apiKey, options = {}) {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('License or trial key is required');
  }

  const res = await fetch(`${API_URL}/verify-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: cleanKey })
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (data.code === 'TRIAL_NOT_ACTIVATED' && options.activateIfUnusedTrial) {
      return activateTrial({ trialKey: cleanKey, email: options.email });
    }
    throw createDetailedError(data.error || 'Validation failed', { httpStatus: res.status, ...data });
  }

  const nextState = buildLicenseStatePayload(cleanKey, data);
  await chrome.storage.local.set({ licenseState: nextState });

  startHeartbeat(nextState.expiresAt || null);
  return { ...data, ...nextState };
}

/**
 * @param {{ trialKey?: string, email?: string }} [params]
 * @returns {Promise<LicenseState & Record<string, any>>}
 */
async function activateTrial({ trialKey = '', email = '' } = {}) {
  const cleanKey = String(trialKey || '').trim();
  const cleanEmail = email ? String(email).trim() : '';

  if (!cleanKey) {
    throw new Error('Trial key is required');
  }

  const res = await fetch(`${API_URL}/trial/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trialKey: cleanKey,
      ...(cleanEmail ? { email: cleanEmail } : {})
    })
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (data.code === 'TRIAL_EXPIRED' || data.expired) {
      await chrome.storage.local.set({
        licenseState: {
          valid: false,
          expired: true,
          revoked: false,
          sessionToken: cleanKey,
          accessType: 'trial',
          expiresAt: data.expiresAt || null,
          statusCode: data.code || 'TRIAL_EXPIRED',
          error: data.error || 'Trial has expired',
          lastCheckedAt: Date.now()
        }
      });
    }
    throw createDetailedError(data.error || 'Trial activation failed', { httpStatus: res.status, ...data });
  }

  const nextState = buildLicenseStatePayload(cleanKey, {
    ...data,
    accessType: 'trial'
  });
  await chrome.storage.local.set({ licenseState: nextState });

  startHeartbeat(nextState.expiresAt || null);
  return { ...data, ...nextState };
}

/**
 * @param {Partial<LicenseState> & Record<string, any>} [revokedInfo]
 */
async function handleAccessRevoked(revokedInfo = {}) {
  if (extractionSession.isExtracting) {
    if (extractionSession.tabId && chrome.tabs?.sendMessage) {
      await chrome.tabs.sendMessage(extractionSession.tabId, {
        action: 'stopExtraction',
        sessionId: extractionSession.sessionId
      }).catch(() => {});
    }
    extractionSession.isExtracting = false;
    extractionSession.stopped = true;
    extractionSession.statusText = revokedInfo.error || 'Access expired or revoked';
    await persistSession();
  }

  broadcastSession({
    licenseRevoked: true,
    licenseState: revokedInfo
  });

  if (chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
      action: 'accessRevoked',
      licenseState: revokedInfo
    }).catch(() => {});
  }
}

/**
 * @param {{ broadcastOnFailure?: boolean }} [options]
 * @returns {Promise<LicenseState>}
 */
async function verifyLicenseNow({ broadcastOnFailure = true } = {}) {
  const data = await chrome.storage.local.get('licenseState');
  /** @type {LicenseState | undefined} */
  const current = data?.licenseState;

  if (!current || !current.sessionToken) {
    return {
      valid: false,
      status: 'unauthenticated',
      error: 'No active license or trial key found.'
    };
  }

  try {
    return await validateLicense(current.sessionToken, { activateIfUnusedTrial: false });
  } catch (error) {
    const details = getErrorDetails(error);
    const errorMessage = getErrorMessage(error, 'License verification failed');
    const msg = errorMessage.toLowerCase();

    // Network/transport error without HTTP status
    if (!details) {
      if (current.expiresAt && new Date(current.expiresAt) <= new Date()) {
        /** @type {LicenseState} */
        const expiredState = {
          ...current,
          valid: false,
          expired: true,
          revoked: false,
          statusCode: current.accessType === 'trial' ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_EXPIRED',
          error: current.accessType === 'trial'
            ? 'Your trial period has expired. Please purchase a paid subscription.'
            : 'Your subscription has expired. Please renew to continue.',
          lastCheckedAt: Date.now()
        };
        await chrome.storage.local.set({ licenseState: expiredState });
        stopHeartbeat();
        if (broadcastOnFailure) await handleAccessRevoked(expiredState);
        return { ...expiredState, valid: false, status: 'expired' };
      }

      return {
        valid: false,
        status: 'network_error',
        networkError: true,
        accessType: current.accessType || 'paid',
        error: 'Unable to reach verification server. Please check your connection.'
      };
    }

    if (
      details.expired ||
      details.code === 'TRIAL_EXPIRED' ||
      details.code === 'SUBSCRIPTION_EXPIRED' ||
      msg.includes('expired') ||
      msg.includes('over')
    ) {
      /** @type {LicenseState} */
      const expiredState = {
        ...current,
        valid: false,
        expired: true,
        revoked: false,
        accessType: details.accessType || current.accessType || 'paid',
        statusCode: details.code || 'EXPIRED',
        expiresAt: details.expiresAt || current.expiresAt || null,
        error: errorMessage,
        lastCheckedAt: Date.now()
      };
      await chrome.storage.local.set({ licenseState: expiredState });
      stopHeartbeat();
      if (broadcastOnFailure) await handleAccessRevoked(expiredState);
      return { ...expiredState, valid: false, status: 'expired' };
    }

    if (details.code === 'KEY_REVOKED' || details.code === 'SUBSCRIPTION_REVOKED' || msg.includes('revoked')) {
      /** @type {LicenseState} */
      const revokedState = {
        ...current,
        valid: false,
        expired: false,
        revoked: true,
        accessType: details.accessType || current.accessType || 'paid',
        statusCode: details.code || 'REVOKED',
        error: errorMessage,
        lastCheckedAt: Date.now()
      };
      await chrome.storage.local.set({ licenseState: revokedState });
      stopHeartbeat();
      if (broadcastOnFailure) await handleAccessRevoked(revokedState);
      return { ...revokedState, valid: false, status: 'revoked' };
    }

    if (details.code === 'TRIAL_NOT_ACTIVATED') {
      /** @type {LicenseState} */
      const unusedState = {
        ...current,
        valid: false,
        expired: false,
        revoked: false,
        canActivate: true,
        accessType: 'trial',
        statusCode: 'TRIAL_NOT_ACTIVATED',
        email: details.email || current.email || null,
        durationDays: details.durationDays || current.durationDays || null,
        error: errorMessage,
        lastCheckedAt: Date.now()
      };
      await chrome.storage.local.set({ licenseState: unusedState });
      stopHeartbeat();
      if (broadcastOnFailure) await handleAccessRevoked(unusedState);
      return { ...unusedState, valid: false, status: 'trial_not_activated' };
    }

    // Deleted / non-existent key
    await logoutLicense();
    /** @type {LicenseState} */
    const deletedState = {
      valid: false,
      expired: false,
      revoked: false,
      deleted: true,
      error: errorMessage
    };
    if (broadcastOnFailure) await handleAccessRevoked(deletedState);
    return { ...deletedState, status: 'deleted' };
  }
}

/** @returns {Promise<LicenseState>} */
async function getLicenseState() {
  const data = await chrome.storage.local.get('licenseState');
  /** @type {LicenseState} */
  const state = data?.licenseState || { valid: false };
  if (state.valid && state.expiresAt && new Date(state.expiresAt) <= new Date()) {
    /** @type {LicenseState} */
    const expiredState = {
      ...state,
      valid: false,
      expired: true,
      statusCode: state.accessType === 'trial' ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_EXPIRED',
      error: state.accessType === 'trial'
        ? 'Your trial period has expired. Please purchase a paid subscription.'
        : 'Your subscription has expired.'
    };
    await chrome.storage.local.set({ licenseState: expiredState });
    return expiredState;
  }
  return state;
}

async function logoutLicense() {
  stopHeartbeat();
  await chrome.storage.local.remove('licenseState');
}

/**
 * @param {string | null} expiresAt
 */
function scheduleExactExpiryCheck(expiresAt) {
  if (expiryTimeout !== null) {
    clearTimeout(expiryTimeout);
    expiryTimeout = null;
  }
  if (!expiresAt) return;
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  // Schedule exact boundary check when expiry is within 6 hours
  if (remainingMs > 0 && remainingMs <= 6 * 60 * 60 * 1000) {
    expiryTimeout = setTimeout(() => {
      verifyLicenseNow({ broadcastOnFailure: true }).catch(() => {});
    }, remainingMs + 1000);
  }
}

/**
 * @param {string | null} [expiresAt]
 */
async function startHeartbeat(expiresAt = null) {
  stopHeartbeat();
  scheduleExactExpiryCheck(expiresAt);

  if (typeof chrome !== 'undefined' && chrome.alarms?.create) {
    chrome.alarms.create(LICENSE_ALARM_NAME, { periodInMinutes: 1 });
  }

  heartbeatInterval = setInterval(async () => {
    await verifyLicenseNow({ broadcastOnFailure: true });
  }, 60 * 1000);
}

function stopHeartbeat() {
  if (heartbeatInterval !== null) clearInterval(heartbeatInterval);
  heartbeatInterval = null;
  if (expiryTimeout !== null) clearTimeout(expiryTimeout);
  expiryTimeout = null;
  if (typeof chrome !== 'undefined' && chrome.alarms?.clear) {
    chrome.alarms.clear(LICENSE_ALARM_NAME).catch(() => {});
  }
}

if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LICENSE_ALARM_NAME) {
      verifyLicenseNow({ broadcastOnFailure: true }).catch(() => {});
    }
  });
}

// Start heartbeat on load if a license or trial key is present
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  getLicenseState().then(state => {
    if (state.valid) startHeartbeat(state.expiresAt || null);
  }).catch(() => {});
}

// ── Handle progress updates from content script ───────────────────────────────
/**
 * @param {any} message
 * @param {chrome.runtime.MessageSender} _sender
 */
function handleExtractionProgress(message, _sender) {
  if (!extractionSession.isExtracting) return;
  if (message.sessionId && message.sessionId !== extractionSession.sessionId) return;

  // Update session state
  if (typeof message.totalFound === 'number') extractionSession.totalFound = message.totalFound;
  if (typeof message.totalSaved === 'number') extractionSession.totalSaved = message.totalSaved;
  if (typeof message.percent === 'number') extractionSession.percent = Math.max(0, Math.min(100, message.percent));
  if (message.statusText) extractionSession.statusText = message.statusText;
  if (message.error) {
    extractionSession.totalFailed = (extractionSession.totalFailed || 0) + 1;
    extractionSession.errors = [...(extractionSession.errors || []).slice(-9), String(message.error)];
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
/**
 * @param {string} url
 * @param {string[]} [keywords]
 * @returns {Promise<any[]>}
 */
async function extractFromUrl(url, keywords = []) {
  const access = await verifyLicenseNow({ broadcastOnFailure: true });
  if (!access.valid) {
    throw new Error(access.error || 'Access expired or unauthorized');
  }
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (typeof tab.id !== 'number') {
      throw new Error('Failed to create background tab');
    }
    const tabId = tab.id;
    await waitForTabStatus(tabId, 'complete');
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'extract',
      keywords,
      source: url
    });
    await chrome.tabs.remove(tabId).catch(() => { });
    return response?.leads || [];
  } catch (error) {
    console.error('[BG] URL extraction error:', error);
    return [];
  }
}

// ── Wait for a tab to reach a given status ───────────────────────────────────
/**
 * @param {number} tabId
 * @param {string} [status]
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function waitForTabStatus(tabId, status = 'complete', timeoutMs = 30000) {
  return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);

    /**
     * @param {number} updatedTabId
     * @param {chrome.tabs.TabChangeInfo} info
     */
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
/**
 * @param {string} url
 * @returns {Promise<void>}
 */
async function openWhatsAppAndSend(url) {
  if (!url) throw new Error('WhatsApp URL is missing');
  const access = await verifyLicenseNow({ broadcastOnFailure: true });
  if (!access.valid) {
    throw new Error(access.error || 'Access expired or unauthorized');
  }

  // Open the wa.me redirect URL
  const tab = await chrome.tabs.create({ url, active: true });
  if (typeof tab.id !== 'number') {
    throw new Error('Failed to open WhatsApp tab');
  }
  const tabId = tab.id;

  // wa.me redirects to web.whatsapp.com – wait for that to fully load
  await waitForWhatsAppReady(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, { action: 'autoSendWhatsApp' });
  } catch (error) {
    // Silently allow – WhatsApp was opened, auto-send may have minor issues
    console.warn('[BG] WhatsApp auto-send warning:', getErrorMessage(error));
  }
}

// ── Wait until the WhatsApp chat page is fully ready ─────────────────────────
/**
 * @param {number} tabId
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForWhatsAppReady(tabId, timeoutMs = 45000) {
  // Phase 1: wait for any redirect to settle (URL contains whatsapp.com)
  await new Promise((/** @type {(value?: void) => void} */ resolve) => {
    /**
     * @param {number} updatedTabId
     * @param {chrome.tabs.TabChangeInfo} info
     * @param {chrome.tabs.Tab} updatedTab
     */
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

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Extension installed ───────────────────────────────────────────────────────
if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
      console.log('[BG] Map Leadify installed');
      await resetSession();
    }
  });
}
