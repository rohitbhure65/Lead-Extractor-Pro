// Map Leadify – Popup Script (v2)
// Manages UI, state sync with background, WhatsApp templates, lead CRUD

'use strict';

/**
 * @typedef {Object} ExtractionSettings
 * @property {number} limit
 * @property {boolean} noLimit
 * @property {boolean} requirePhone
 * @property {boolean} requireWebsite
 * @property {boolean} requireEmail
 * @property {string} countryCode
 */

/**
 * @typedef {Object} AccessInfo
 * @property {boolean} [valid]
 * @property {string} [status]
 * @property {boolean} [expired]
 * @property {boolean} [revoked]
 * @property {boolean} [networkError]
 * @property {boolean} [upgradedFromTrial]
 * @property {string} [accessType]
 * @property {string | null} [code]
 * @property {string | null} [statusCode]
 * @property {string | null} [sessionToken]
 * @property {string | null} [expiresAt]
 * @property {number | null} [remainingMs]
 * @property {number | null} [durationDays]
 * @property {string | null} [error]
 */

/**
 * @typedef {Object} PopupSessionState
 * @property {boolean} isExtracting
 * @property {string | null} [sessionId]
 * @property {number | null} [startTime]
 * @property {number} [percent]
 * @property {string} [statusText]
 * @property {number} [totalFound]
 * @property {number} [totalSaved]
 * @property {number} [totalFailed]
 * @property {boolean} [completed]
 * @property {boolean} [stopped]
 * @property {boolean} [licenseRevoked]
 * @property {AccessInfo} [licenseState]
 * @property {string[]} [errors]
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_COUNTRY_CODE = '+91';
/** @type {WhatsAppTemplate} */
const DEFAULT_TEMPLATE = {
  id: 'tpl_default',
  name: 'General Pitch',
  body: `Hi {{name}}, I came across your business {{company}} on Google.

I noticed that you don't have a proper website / Android App / automation system yet. You might be missing potential customers online.

I help businesses like yours get more leads using websites, Android App, WhatsApp automation, and simple tools.

Would you be open to a quick 5-minute chat? I can show you how it can help your business.`,
  createdAt: Date.now()
};

// ── App Class ─────────────────────────────────────────────────────────────────
class LeadExtractor {
  constructor() {
    // Lead collections (in-memory, mirrored from IndexedDB)
    /** @type {StoredLead[]} */
    this.leads = [];
    /** @type {StoredLead[]} */
    this.extractedLeads = [];
    /** @type {StoredLead[]} */
    this.savedLeads = [];
    /** @type {StoredLead[]} */
    this.filteredLeads = [];

    // UI state
    this.activeTab = 'extracted';
    this.searchQuery = '';
    this.savedSearchQuery = '';
    this.typeFilter = 'all';
    this.renderedLeadCount = 0;
    this.renderBatchSize = 25;
    this.activeSidebarPanel = 'extractPanel';

    // Extraction state (mirrors background)
    this.isExtracting = false;
    /** @type {string | null} */
    this.activeSessionId = null;
    /** @type {number | null} */
    this.currentTabId = null;
    this.currentSessionSaved = 0;
    /** @type {number | null} */
    this.extractionStartTime = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.elapsedTimer = null;

    // Settings
    /** @type {ExtractionSettings | null} */
    this.extractionSettings = null;

    // Templates
    /** @type {WhatsAppTemplate[]} */
    this.templates = [];
    /** @type {string | null} */
    this.defaultTemplateId = null;
    /** @type {string | null} */
    this.editingTemplateId = null;

    // Licensing & access monitoring state
    /** @type {AccessInfo | null} */
    this.accessState = null;
    this._isUnlocked = false;
    this._licenseEventsBound = false;
    this._eventsBound = false;
    this._runtimeListenersBound = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._accessPollTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._accessExpiryTimer = null;

    // Confirm dialog promise resolver
    /** @type {((confirmed: boolean) => void) | null} */
    this._confirmResolve = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._toastTimer = null;

    this.init();
  }

  /**
   * @param {string} id
   * @returns {HTMLElement | null}
   */
  byId(id) {
    return document.getElementById(id);
  }

  /**
   * @param {string} id
   * @returns {HTMLInputElement | null}
   */
  inputEl(id) {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement ? el : null;
  }

  /**
   * @param {string} id
   * @returns {HTMLTextAreaElement | null}
   */
  textareaEl(id) {
    const el = document.getElementById(id);
    return el instanceof HTMLTextAreaElement ? el : null;
  }

  /**
   * @param {string} id
   * @returns {HTMLSelectElement | null}
   */
  selectEl(id) {
    const el = document.getElementById(id);
    return el instanceof HTMLSelectElement ? el : null;
  }

  /**
   * @param {string} id
   * @returns {HTMLButtonElement | null}
   */
  buttonEl(id) {
    const el = document.getElementById(id);
    return el instanceof HTMLButtonElement ? el : null;
  }

  /**
   * @param {string} id
   * @returns {HTMLAnchorElement | null}
   */
  anchorEl(id) {
    const el = document.getElementById(id);
    return el instanceof HTMLAnchorElement ? el : null;
  }

  getPricingUrl() {
    if (typeof ENV !== 'undefined' && ENV.APP_URL) {
      return `${ENV.APP_URL.replace(/\/$/, '')}/#pricing`;
    }
    return '#pricing';
  }

  /** @returns {Promise<AccessInfo>} */
  async verifyLicenseWithServer() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'verifyLicenseNow', broadcast: false }, res => {
        if (chrome.runtime.lastError) {
          resolve({ valid: false, status: 'error', error: chrome.runtime.lastError.message || 'Verification failed' });
        } else {
          resolve(res || { valid: false, status: 'error', error: 'Verification failed' });
        }
      });
    });
  }

  async init() {
    try {
      this.bindLicenseEvents();
      this.bindRuntimeListeners();

      /** @type {AccessInfo | null} */
      const state = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'getLicenseState' }, resolve);
      });

      if (!state || !state.sessionToken) {
        this.showLicenseOverlay({ status: 'unauthenticated' });
        return; // Halt initialization if no key is configured
      }

      // Always verify with backend on popup open — never trust cached storage alone
      const verified = await this.verifyLicenseWithServer();
      if (!verified || !verified.valid) {
        this.showLicenseOverlay(verified || state);
        return;
      }

      const overlay = this.byId('licenseOverlay');
      if (overlay) overlay.style.display = 'none';
      this.accessState = verified;
      this._isUnlocked = true;
      this.renderAccessStatus(verified);
      this.startLiveAccessMonitor(verified);

      await this.loadSettings();
      await this.loadLeads();
      await this.loadTemplates();
      this.bindEvents();
      this.renderVersion();
      this.renderAll();
      // Re-hydrate extraction state from background
      await this.syncExtractionState();
    } catch (err) {
      console.error('[Popup] Init error:', err);
      this.showToast('Extension error on init', 'error');
    }
  }

  /**
   * @param {'paid' | 'trial'} mode
   */
  switchLicenseMode(mode) {
    const paidTab = this.byId('modePaidTab');
    const trialTab = this.byId('modeTrialTab');
    const paidSec = this.byId('paidKeySection');
    const trialSec = this.byId('trialKeySection');
    const err = this.byId('licenseError');
    if (err) {
      err.textContent = '';
      err.style.display = 'none';
    }

    if (mode === 'trial') {
      paidTab?.classList.remove('active');
      trialTab?.classList.add('active');
      if (paidSec) paidSec.style.display = 'none';
      if (trialSec) trialSec.style.display = 'block';
    } else {
      trialTab?.classList.remove('active');
      paidTab?.classList.add('active');
      if (trialSec) trialSec.style.display = 'none';
      if (paidSec) paidSec.style.display = 'block';
    }
  }

  bindLicenseEvents() {
    if (this._licenseEventsBound) return;
    this._licenseEventsBound = true;

    const pricingUrl = this.getPricingUrl();
    const buyLink = this.anchorEl('buySubscriptionLink');
    const buyCta = this.anchorEl('buyAccessCta');
    if (buyLink) buyLink.href = pricingUrl;
    if (buyCta) buyCta.href = pricingUrl;

    this.byId('modePaidTab')?.addEventListener('click', () => this.switchLicenseMode('paid'));
    this.byId('modeTrialTab')?.addEventListener('click', () => this.switchLicenseMode('trial'));

    const submitLicense = async () => {
      const btn = this.buttonEl('activateLicenseBtn');
      const input = this.inputEl('licenseKeyInput');
      const err = this.byId('licenseError');
      if (!btn || !input || !err) return;
      const key = input.value.trim();

      if (!key) {
        err.textContent = 'Please enter a valid API Key or Trial Key.';
        err.style.display = 'block';
        return;
      }

      btn.textContent = 'Verifying...';
      btn.disabled = true;
      err.textContent = '';
      err.style.display = 'none';

      try {
        /** @type {any} */
        const result = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { action: 'validateLicense', apiKey: key, activateIfUnusedTrial: true },
            res => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(res);
            }
          );
        });

        if (result?.valid) {
          input.value = '';
          const overlay = this.byId('licenseOverlay');
          if (overlay) overlay.style.display = 'none';
          this.showToast(
            result.accessType === 'trial' ? 'Trial access activated!' : 'Pro license activated!',
            'success'
          );
          await this.init();
        } else if (result?.status === 'expired' || result?.status === 'revoked') {
          this.showLicenseOverlay(result);
        } else {
          err.textContent = result?.error || 'Invalid key';
          err.style.display = 'block';
        }
      } catch (e) {
        err.textContent = 'Failed to connect to verification server';
        err.style.display = 'block';
      } finally {
        btn.textContent = 'Activate Now';
        btn.disabled = false;
      }
    };

    const submitTrial = async () => {
      const btn = this.buttonEl('activateTrialBtn');
      const keyInput = this.inputEl('trialKeyInput');
      const emailInput = this.inputEl('trialEmailInput');
      const err = this.byId('licenseError');
      if (!btn || !keyInput || !emailInput || !err) return;
      const trialKey = keyInput.value.trim();
      const email = emailInput.value.trim();

      if (!trialKey) {
        err.textContent = 'Please enter your Trial Key.';
        err.style.display = 'block';
        return;
      }

      btn.textContent = 'Activating Trial...';
      btn.disabled = true;
      err.textContent = '';
      err.style.display = 'none';

      try {
        /** @type {any} */
        const result = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ action: 'activateTrial', trialKey, email }, res => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(res);
          });
        });

        if (result?.valid) {
          keyInput.value = '';
          emailInput.value = '';
          const overlay = this.byId('licenseOverlay');
          if (overlay) overlay.style.display = 'none';
          this.showToast(`One-time trial activated (${result.durationDays} days)!`, 'success');
          await this.init();
        } else if (result?.status === 'expired') {
          this.showLicenseOverlay(result);
        } else {
          err.textContent = result?.error || 'Unable to activate trial';
          err.style.display = 'block';
        }
      } catch (e) {
        err.textContent = 'Failed to connect to verification server';
        err.style.display = 'block';
      } finally {
        btn.textContent = 'Activate One-Time Trial';
        btn.disabled = false;
      }
    };

    this.byId('activateLicenseBtn')?.addEventListener('click', submitLicense);
    this.byId('licenseKeyInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitLicense(); }
    });

    this.byId('activateTrialBtn')?.addEventListener('click', submitTrial);
    this.byId('trialKeyInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitTrial(); }
    });
    this.byId('trialEmailInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitTrial(); }
    });

    this.byId('refreshAccessBtn')?.addEventListener('click', async () => {
      const refreshBtn = this.buttonEl('refreshAccessBtn');
      const err = this.byId('licenseError');
      if (!refreshBtn) return;
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Checking Server...';
      try {
        const res = await this.verifyLicenseWithServer();
        if (res?.valid) {
          const overlay = this.byId('licenseOverlay');
          if (overlay) overlay.style.display = 'none';
          this.showToast(
            res.upgradedFromTrial ? 'Upgraded to Paid Subscription!' : 'Access verified!',
            'success'
          );
          await this.init();
        } else {
          this.showLicenseOverlay(res);
          if (err && res?.error) {
            err.textContent = res.error;
            err.style.display = 'block';
          }
        }
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'I Purchased — Refresh Access';
      }
    });
  }

  /**
   * @param {AccessInfo | boolean} [accessInfo]
   */
  showLicenseOverlay(accessInfo = {}) {
    this._isUnlocked = false;
    this.stopLiveAccessMonitor();

    /** @type {AccessInfo} */
    const info = typeof accessInfo === 'boolean'
      ? { expired: accessInfo, status: accessInfo ? 'expired' : 'unauthenticated' }
      : (accessInfo || {});

    const overlay = this.byId('licenseOverlay');
    const banner = this.byId('licenseStatusBanner');
    const badge = this.byId('licenseStatusBadge');
    const bannerMsg = this.byId('licenseStatusMessage');
    const expiredActions = this.byId('expiredActions');
    const buyCta = this.anchorEl('buyAccessCta');
    const err = this.byId('licenseError');
    const title = this.byId('licenseTitle');
    const desc = this.byId('licenseDesc');
    const link = this.anchorEl('buySubscriptionLink');
    const sidebarBar = this.byId('accessStatusBar');

    if (sidebarBar) sidebarBar.style.display = 'none';
    const pricingUrl = this.getPricingUrl();
    if (link) link.href = pricingUrl;
    if (buyCta) buyCta.href = pricingUrl;

    if (overlay) overlay.style.display = 'flex';
    banner?.classList.remove('revoked');

    const isExpired = info.status === 'expired' || Boolean(info.expired);
    const isRevoked = info.status === 'revoked' || Boolean(info.revoked);
    const isNetworkError = info.status === 'network_error' || Boolean(info.networkError);
    const isTrial = info.accessType === 'trial' || info.code === 'TRIAL_EXPIRED' || info.statusCode === 'TRIAL_EXPIRED';

    if (isExpired) {
      if (banner) banner.style.display = 'block';
      if (expiredActions) expiredActions.style.display = 'flex';
      if (badge) badge.textContent = isTrial ? 'TRIAL EXPIRED' : 'SUBSCRIPTION EXPIRED';
      if (title) title.textContent = isTrial ? 'Your Trial Has Expired' : 'Subscription Expired';
      if (desc) {
        desc.textContent = isTrial
          ? 'Your one-time trial has ended and cannot be reactivated. Purchase full access to continue extracting and exporting leads.'
          : 'Your approved subscription period has ended. Submit a renewal payment to restore full access.';
      }
      const endedStr = info.expiresAt ? ` Ended: ${new Date(info.expiresAt).toLocaleString()}.` : '';
      if (bannerMsg) {
        bannerMsg.textContent = (info.error || (isTrial ? 'Trial period expired.' : 'Subscription expired.')) + endedStr;
      }
      if (buyCta) {
        buyCta.style.display = 'flex';
        buyCta.textContent = isTrial ? 'Purchase Full Access' : 'Renew Subscription';
      }
      if (link) link.textContent = 'Need help or want to check payment status? Open Dashboard';
      if (err) {
        err.textContent = '';
        err.style.display = 'none';
      }
      this.switchLicenseMode('paid');
    } else if (isRevoked) {
      if (banner) {
        banner.style.display = 'block';
        banner.classList.add('revoked');
      }
      if (expiredActions) expiredActions.style.display = 'flex';
      if (badge) badge.textContent = 'ACCESS REVOKED';
      if (title) title.textContent = 'Access Revoked';
      if (desc) desc.textContent = 'This license key or subscription has been revoked by the administrator.';
      if (bannerMsg) bannerMsg.textContent = info.error || 'Access revoked.';
      if (buyCta) {
        buyCta.style.display = 'flex';
        buyCta.textContent = 'Purchase Full Access';
      }
      if (err) {
        err.textContent = '';
        err.style.display = 'none';
      }
      this.switchLicenseMode('paid');
    } else if (isNetworkError) {
      if (banner) banner.style.display = 'block';
      if (expiredActions) expiredActions.style.display = 'flex';
      if (badge) badge.textContent = 'SERVER VERIFICATION REQUIRED';
      if (title) title.textContent = 'Verification Unavailable';
      if (desc) desc.textContent = 'Could not reach the backend server to verify your active access status.';
      if (bannerMsg) bannerMsg.textContent = info.error || 'Please verify your internet connection and retry.';
      if (buyCta) buyCta.style.display = 'none';
      if (err) {
        err.textContent = '';
        err.style.display = 'none';
      }
    } else {
      if (banner) banner.style.display = 'none';
      if (expiredActions) expiredActions.style.display = 'none';
      if (title) title.textContent = 'Activate Access';
      if (desc) desc.textContent = 'Enter your paid license key or one-time trial key to unlock Map Leadify.';
      if (link) link.textContent = 'Don\'t have a key? Purchase Full Access';
      if (err) {
        if (info.error && info.status !== 'unauthenticated') {
          err.textContent = info.error;
          err.style.display = 'block';
        } else {
          err.textContent = '';
          err.style.display = 'none';
        }
      }
      if (info.status === 'trial_not_activated') {
        this.switchLicenseMode('trial');
      }
    }
  }

  /**
   * @param {string | null | undefined} expiresAt
   * @param {number | null | undefined} [remainingMs]
   * @returns {string}
   */
  formatRemainingTime(expiresAt, remainingMs) {
    const ms = expiresAt
      ? Math.max(0, new Date(expiresAt).getTime() - Date.now())
      : Math.max(0, Number(remainingMs || 0));
    if (!ms) return 'Expired';
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const mins = totalMinutes % 60;
    if (days >= 1) return `${days}d ${hours}h left`;
    if (hours >= 1) return `${hours}h ${mins}m left`;
    return `${Math.max(1, mins)}m left`;
  }

  /**
   * @param {AccessInfo | null | undefined} accessInfo
   */
  renderAccessStatus(accessInfo) {
    const bar = this.byId('accessStatusBar');
    const badge = this.byId('accessTypeBadge');
    const remainingEl = this.byId('accessRemainingText');
    const upgradeLink = this.anchorEl('upgradeToProLink');
    if (!bar || !accessInfo) return;

    const isTrial = accessInfo.accessType === 'trial';
    bar.style.display = 'flex';

    if (badge) {
      badge.textContent = isTrial ? 'TRIAL' : 'PRO';
      badge.className = `access-badge ${isTrial ? 'trial' : 'pro'}`;
    }

    if (upgradeLink) {
      upgradeLink.href = this.getPricingUrl();
      upgradeLink.style.display = isTrial ? 'inline-block' : 'none';
    }

    if (remainingEl) {
      const remainingText = accessInfo.expiresAt
        ? this.formatRemainingTime(accessInfo.expiresAt, accessInfo.remainingMs)
        : 'Active';
      remainingEl.textContent = remainingText;
      remainingEl.title = accessInfo.expiresAt
        ? `Expires: ${new Date(accessInfo.expiresAt).toLocaleString()}`
        : 'Active';
    }
  }

  /**
   * @param {AccessInfo | null | undefined} accessInfo
   */
  startLiveAccessMonitor(accessInfo) {
    this.stopLiveAccessMonitor();

    // Periodic server verification while popup stays open
    this._accessPollTimer = setInterval(async () => {
      if (!this._isUnlocked) return;
      const res = await this.verifyLicenseWithServer();
      if (!res?.valid) {
        this.handleAccessLost(res);
      } else {
        this.accessState = res;
        this.renderAccessStatus(res);
      }
    }, 30 * 1000);

    // Schedule exact expiry boundary re-verification when expiry is near
    if (accessInfo?.expiresAt) {
      const ms = new Date(accessInfo.expiresAt).getTime() - Date.now();
      if (ms > 0 && ms <= 6 * 60 * 60 * 1000) {
        this._accessExpiryTimer = setTimeout(async () => {
          const res = await this.verifyLicenseWithServer();
          if (!res?.valid) this.handleAccessLost(res);
        }, ms + 1000);
      }
    }
  }

  stopLiveAccessMonitor() {
    if (this._accessPollTimer !== null) {
      clearInterval(this._accessPollTimer);
      this._accessPollTimer = null;
    }
    if (this._accessExpiryTimer !== null) {
      clearTimeout(this._accessExpiryTimer);
      this._accessExpiryTimer = null;
    }
  }

  /**
   * @param {AccessInfo} [accessInfo]
   */
  handleAccessLost(accessInfo = {}) {
    if (this.isExtracting) {
      if (this.currentTabId) {
        chrome.tabs.sendMessage(this.currentTabId, {
          action: 'stopExtraction',
          sessionId: this.activeSessionId
        }).catch(() => {});
      }
      this.isExtracting = false;
      this.activeSessionId = null;
      this.stopElapsedTimer();
      this.updateExtractionButtons();
    }

    ['addLeadModal', 'editLeadModal', 'savedLeadViewModal', 'confirmModal'].forEach(id => this.closeModal(id));
    this.showLicenseOverlay(accessInfo);
  }

  /** @returns {Promise<boolean>} */
  async ensureValidAccess() {
    const res = await this.verifyLicenseWithServer();
    if (!res || !res.valid) {
      this.handleAccessLost(res);
      return false;
    }
    this.accessState = res;
    this.renderAccessStatus(res);
    return true;
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  async loadSettings() {
    const saved = await LeadStorage.get('extractionSettings');
    this.extractionSettings = {
      limit: saved?.limit || 100,
      noLimit: saved?.noLimit !== undefined ? Boolean(saved.noLimit) : true,
      requirePhone: saved?.requirePhone !== undefined ? Boolean(saved.requirePhone) : true,
      requireWebsite: saved?.requireWebsite !== undefined ? Boolean(saved.requireWebsite) : false,
      requireEmail: saved?.requireEmail !== undefined ? Boolean(saved.requireEmail) : false,
      countryCode: this.normalizeCountryCode(saved?.countryCode || DEFAULT_COUNTRY_CODE)
    };
    this.renderSettings();
  }

  async saveSettings() {
    const limitInput = this.inputEl('maxLeadsInput');
    const noLimitInput = this.inputEl('noLimitInput');
    const countryCodeInput = this.inputEl('countryCodeInput');
    const reqPhone = this.inputEl('requirePhoneInput');
    const reqWebsite = this.inputEl('requireWebsiteInput');
    const reqEmail = this.inputEl('requireEmailInput');

    const parsedLimit = parseInt(limitInput?.value || '100', 10);
    const ccDigits = this.getCountryCodeDigits(countryCodeInput?.value);
    const countryCode = this.normalizeCountryCode(ccDigits || DEFAULT_COUNTRY_CODE);
    if (countryCodeInput) countryCodeInput.value = this.getCountryCodeDigits(countryCode);

    this.extractionSettings = {
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100,
      noLimit: Boolean(noLimitInput?.checked),
      requirePhone: Boolean(reqPhone?.checked),
      requireWebsite: Boolean(reqWebsite?.checked),
      requireEmail: Boolean(reqEmail?.checked),
      countryCode
    };

    await LeadStorage.set('extractionSettings', this.extractionSettings);
  }

  renderSettings() {
    const s = this.extractionSettings;
    if (!s) return;
    const maxLeads = this.inputEl('maxLeadsInput');
    const noLimit = this.inputEl('noLimitInput');
    const reqPhone = this.inputEl('requirePhoneInput');
    const reqWebsite = this.inputEl('requireWebsiteInput');
    const reqEmail = this.inputEl('requireEmailInput');
    const countryCode = this.inputEl('countryCodeInput');

    if (maxLeads) {
      maxLeads.value = String(s.limit);
      maxLeads.disabled = s.noLimit;
    }
    if (noLimit) noLimit.checked = s.noLimit;
    if (reqPhone) reqPhone.checked = s.requirePhone;
    if (reqWebsite) reqWebsite.checked = s.requireWebsite;
    if (reqEmail) reqEmail.checked = s.requireEmail;
    if (countryCode) countryCode.value = this.getCountryCodeDigits(s.countryCode);

    const phoneNote = this.byId('phoneNote');
    if (phoneNote) {
      phoneNote.textContent = 'Tip: Disable "Phone Only" for Google Maps – most listings don\'t show phones.';
    }
  }

  renderVersion() {
    const badge = this.byId('versionBadge');
    if (badge) badge.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  // ── Storage / Leads ───────────────────────────────────────────────────────
  async loadLeads() {
    const stored = await LeadStorage.getAllLeads();
    this.leads = stored.map(l => this.normalizeStoredLead(l));
    this.extractedLeads = this.leads.filter(l => !l.type || l.type === 'extracted');
    this.savedLeads = this.leads.filter(l => l.type === 'saved');
    this.applyFilters();
    this.updateBadges();
  }

  // ── Templates ─────────────────────────────────────────────────────────────
  async loadTemplates() {
    this.templates = await LeadStorage.getTemplates();
    this.defaultTemplateId = (await LeadStorage.getDefaultTemplateId()) || null;

    // Seed default template on first install
    if (this.templates.length === 0) {
      await LeadStorage.addTemplate(DEFAULT_TEMPLATE);
      this.templates = [DEFAULT_TEMPLATE];
      this.defaultTemplateId = DEFAULT_TEMPLATE.id;
    }

    // Set textarea to current default template
    this.loadTemplateIntoTextarea(this.defaultTemplateId);
    this.renderTemplates();
    this.renderQuickSelect();
  }

  /** @returns {WhatsAppTemplate} */
  getSelectedTemplate() {
    const id = this.defaultTemplateId;
    const tpl = this.templates.find(t => t.id === id) || this.templates[0] || DEFAULT_TEMPLATE;
    // Use the live textarea content as the message body (user may have edited it)
    const textarea = this.textareaEl('whatsAppMessageInput');
    if (textarea) {
      return { ...tpl, body: textarea.value.trim() || tpl.body };
    }
    return tpl;
  }

  /**
   * @param {string | null} templateId
   */
  loadTemplateIntoTextarea(templateId) {
    const tpl = this.templates.find(t => t.id === templateId) || this.templates[0];
    const textarea = this.textareaEl('whatsAppMessageInput');
    if (textarea && tpl) textarea.value = tpl.body;
  }

  renderQuickSelect() {
    const sel = this.selectEl('templateQuickSelect');
    if (!sel) return;
    sel.innerHTML = this.templates.map(t =>
      `<option value="${this.escapeHtml(t.id)}" ${t.id === this.defaultTemplateId ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`
    ).join('');
  }

  renderTemplates() {
    const list = this.byId('templatesList');
    const empty = this.byId('templatesEmpty');
    if (!list) return;

    if (this.templates.length === 0) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }

    empty?.classList.add('hidden');
    list.innerHTML = this.templates.map(t => {
      const safeId = this.escapeHtml(t.id);
      return `
      <div class="template-item ${t.id === this.defaultTemplateId ? 'is-default' : ''}" data-id="${safeId}">
        <div class="template-item-info">
          <span class="template-item-name">${this.escapeHtml(t.name)}</span>
          ${t.id === this.defaultTemplateId ? '<span class="default-badge">Default</span>' : ''}
        </div>
        <div class="template-item-actions">
          ${t.id !== this.defaultTemplateId ? `<button class="tpl-btn set-default" data-id="${safeId}" title="Set as default">★</button>` : ''}
          <button class="tpl-btn edit" data-id="${safeId}" title="Edit">✏️</button>
          <button class="tpl-btn delete" data-id="${safeId}" title="Delete">🗑️</button>
        </div>
      </div>
    `;
    }).join('');

    list.querySelectorAll('button.set-default').forEach(btn => {
      if (!(btn instanceof HTMLElement)) return;
      btn.addEventListener('click', () => {
        if (btn.dataset.id) this.setDefaultTemplate(btn.dataset.id);
      });
    });
    list.querySelectorAll('button.edit').forEach(btn => {
      if (!(btn instanceof HTMLElement)) return;
      btn.addEventListener('click', () => {
        if (btn.dataset.id) this.openTemplateEditor(btn.dataset.id);
      });
    });
    list.querySelectorAll('button.delete').forEach(btn => {
      if (!(btn instanceof HTMLElement)) return;
      btn.addEventListener('click', () => {
        if (btn.dataset.id) this.deleteTemplate(btn.dataset.id);
      });
    });
  }

  /**
   * @param {string | null} [id]
   */
  openTemplateEditor(id = null) {
    const editor = this.byId('templateEditor');
    const title = this.byId('editorTitle');
    const nameInput = this.inputEl('templateNameInput');
    const bodyInput = this.textareaEl('templateBodyInput');

    this.editingTemplateId = id;

    if (id) {
      const tpl = this.templates.find(t => t.id === id);
      if (!tpl) return;
      if (title) title.textContent = 'Edit Template';
      if (nameInput) nameInput.value = tpl.name;
      if (bodyInput) bodyInput.value = tpl.body;
    } else {
      if (title) title.textContent = 'New Template';
      if (nameInput) nameInput.value = '';
      if (bodyInput) bodyInput.value = '';
    }

    editor?.classList.remove('hidden');
    nameInput?.focus();
  }

  closeTemplateEditor() {
    this.byId('templateEditor')?.classList.add('hidden');
    this.editingTemplateId = null;
  }

  async saveTemplate() {
    const name = (this.inputEl('templateNameInput')?.value || '').trim();
    const body = (this.textareaEl('templateBodyInput')?.value || '').trim();

    if (!name) { this.showToast('Template name is required', 'error'); return; }
    if (!body) { this.showToast('Template message is required', 'error'); return; }

    if (this.editingTemplateId) {
      const existingTpl = this.templates.find(t => t.id === this.editingTemplateId);
      if (!existingTpl) {
        this.showToast('Template not found', 'error');
        return;
      }
      const updated = {
        ...existingTpl,
        name,
        body,
        updatedAt: Date.now()
      };
      await LeadStorage.updateTemplate(updated);
      this.showToast('Template updated', 'success');
    } else {
      /** @type {WhatsAppTemplate} */
      const newTpl = { id: `tpl_${Date.now()}`, name, body, createdAt: Date.now() };
      await LeadStorage.addTemplate(newTpl);
      this.showToast('Template created', 'success');
    }

    await this.loadTemplates();
    this.closeTemplateEditor();
  }

  // Called when user edits the in-sidebar WhatsApp textarea
  async onWhatsAppMessageChange() {
    const textarea = this.textareaEl('whatsAppMessageInput');
    if (!textarea) return;
    const body = textarea.value.trim();
    if (!body) return;
    // Update the active template body in storage
    const activeTpl = this.templates.find(t => t.id === this.defaultTemplateId);
    if (activeTpl) {
      const updated = { ...activeTpl, body, updatedAt: Date.now() };
      await LeadStorage.updateTemplate(updated);
      this.templates = this.templates.map(t => t.id === activeTpl.id ? updated : t);
    }
  }

  /**
   * @param {string} id
   */
  async setDefaultTemplate(id) {
    this.defaultTemplateId = id;
    await LeadStorage.setDefaultTemplateId(id);
    this.loadTemplateIntoTextarea(id);
    this.renderTemplates();
    this.renderQuickSelect();
    this.showToast('Default template updated', 'success');
  }

  /**
   * @param {string} id
   */
  async deleteTemplate(id) {
    if (this.templates.length === 1) {
      this.showToast('Cannot delete the only template', 'error');
      return;
    }

    const confirmed = await this.confirm('Delete Template', 'Are you sure you want to delete this template?');
    if (!confirmed) return;

    await LeadStorage.deleteTemplate(id);
    await this.loadTemplates();
    this.showToast('Template deleted', 'success');
  }

  /**
   * @param {string} variable
   */
  insertVar(variable) {
    // Insert into whichever textarea is focused, else the template body textarea
    const focused = document.activeElement;
    const ta = focused instanceof HTMLTextAreaElement
      ? focused
      : this.textareaEl('templateBodyInput');
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.substring(0, start);
    const after = ta.value.substring(end);
    ta.value = before + variable + after;
    ta.selectionStart = ta.selectionEnd = start + variable.length;
    ta.focus();
  }

  // ── Background State Sync ─────────────────────────────────────────────────
  async syncExtractionState() {
    try {
      /** @type {any} */
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'getExtractionState' }, (resp) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(resp);
        });
      });

      if (response?.session) {
        this.applySessionState(response.session);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Popup] Could not fetch session state from background:', msg);
    }
  }

  /**
   * @param {PopupSessionState} session
   */
  applySessionState(session) {
    this.isExtracting = session.isExtracting;
    this.activeSessionId = session.sessionId || null;
    this.extractionStartTime = session.startTime || null;

    // Update UI
    this.showProgress(session.percent || 0);
    if (!session.isExtracting && !session.completed) {
      this.hideProgress();
    }
    this.setExtractionStatus(session.statusText || 'Ready to scan');
    this.updateLiveStats({
      totalFound: session.totalFound || 0,
      totalSaved: session.totalSaved || 0,
      totalFailed: session.totalFailed || 0
    });
    this.updateExtractionButtons();

    if (session.isExtracting) {
      this.startElapsedTimer(session.startTime);
      this.showLiveStats(true);
    } else {
      this.stopElapsedTimer();
    }

    if (Array.isArray(session.errors) && session.errors.length > 0) {
      this.showErrorLog(session.errors);
    }
  }

  // ── Runtime Message Listeners ─────────────────────────────────────────────
  bindRuntimeListeners() {
    if (this._runtimeListenersBound) return;
    this._runtimeListenersBound = true;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const action = message?.action;

      if (action === 'sessionUpdate') {
        this.handleSessionUpdate(message.session);
        return false;
      }

      if (action === 'accessRevoked') {
        this.handleAccessLost(message.licenseState || { status: 'expired', expired: true });
        return false;
      }

      if (action === 'extractionProgress') {
        this.handleExtractionProgress(message);
        return false;
      }

      if (action === 'leadsCleared') {
        this.loadLeads().then(() => {
          this.setExtractionStatus('Saved leads cleared after page refresh');
          this.renderAll();
        });
        return false;
      }

      if (action === 'saveLeadsRequest') {
        this.handleSaveLeadsRequest(message.leads, sendResponse);
        return true;
      }

      return false;
    });
  }

  /**
   * @param {PopupSessionState | null | undefined} session
   */
  handleSessionUpdate(session) {
    if (!session) return;
    if (session.licenseRevoked) {
      this.handleAccessLost(session.licenseState || { status: 'expired', expired: true });
      return;
    }

    this.isExtracting = session.isExtracting;
    this.activeSessionId = session.sessionId || null;

    this.showProgress(session.percent || 0);
    this.setExtractionStatus(session.statusText || '');
    this.updateLiveStats({
      totalFound: session.totalFound || 0,
      totalSaved: session.totalSaved || 0,
      totalFailed: session.totalFailed || 0
    });
    this.updateExtractionButtons();

    if (!session.isExtracting) {
      this.stopElapsedTimer();
      if (session.completed || session.stopped) {
        setTimeout(() => this.hideProgress(), 1200);
        this.loadLeads().then(() => this.renderAll());
      }
    }

    if (Array.isArray(session.errors) && session.errors.length > 0) {
      this.showErrorLog(session.errors);
    }
  }

  /**
   * @param {Record<string, any>} message
   */
  async handleExtractionProgress(message) {
    if (this.activeSessionId && message.sessionId && message.sessionId !== this.activeSessionId) return;

    if (Array.isArray(message.leads) && message.leads.length > 0) {
      const saved = await this.ingestLeads(message.leads);
      this.currentSessionSaved += saved;
    }

    if (typeof message.percent === 'number') {
      this.showProgress(Math.max(0, Math.min(100, message.percent)));
    }

    if (message.statusText) this.setExtractionStatus(message.statusText);

    this.updateLiveStats({
      totalFound: message.totalFound ?? (this.extractedLeads.length),
      totalSaved: message.totalSaved ?? this.currentSessionSaved,
      totalFailed: message.totalFailed ?? 0
    });
  }

  /**
   * @param {Record<string, any>[]} leadsData
   * @param {(response?: any) => void} sendResponse
   */
  async handleSaveLeadsRequest(leadsData, sendResponse) {
    if (!(await this.ensureValidAccess())) {
      sendResponse({ saved: false, reason: 'unauthorized' });
      return;
    }
    if (!Array.isArray(leadsData) || leadsData.length === 0) {
      sendResponse({ saved: false, reason: 'no_data' });
      return;
    }

    let savedCount = 0;
    for (const leadData of leadsData) {
      /** @type {StoredLead} */
      const preparedLead = {
        ...this.sanitizeLeadForStorage(leadData),
        id: this.generateId(),
        type: 'saved',
        contacted: false,
        contactedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: leadData.source || 'Manual Save'
      };

      if (!this.isDuplicateLead(preparedLead)) {
        await LeadStorage.addLead(preparedLead);
        savedCount++;
      }
    }

    if (savedCount > 0) {
      await this.loadLeads();
      this.renderAll();
      this.showToast(`Saved ${savedCount} new leads`, 'success');
      this.handleTabClick('saved');
      sendResponse({ saved: true, count: savedCount });
    } else {
      this.showToast('All leads already exist', 'info');
      sendResponse({ saved: false, reason: 'all_duplicates' });
    }
  }

  // ── Event Binding ─────────────────────────────────────────────────────────
  bindEvents() {
    if (this._eventsBound) return;
    this._eventsBound = true;

    // Access status controls (sidebar)
    this.byId('sidebarRefreshAccessBtn')?.addEventListener('click', async () => {
      const btn = this.byId('sidebarRefreshAccessBtn');
      btn?.classList.add('spinning');
      try {
        const prevType = this.accessState?.accessType;
        const ok = await this.ensureValidAccess();
        if (ok) {
          if (prevType === 'trial' && this.accessState?.accessType === 'paid') {
            this.showToast('Upgraded to Paid Pro Subscription!', 'success');
          } else {
            this.showToast('Access status verified', 'success');
          }
        }
      } finally {
        setTimeout(() => btn?.classList.remove('spinning'), 500);
      }
    });

    this.byId('logoutLicenseBtn')?.addEventListener('click', async () => {
      const confirmed = await this.confirm('Switch Key / Sign Out', 'Remove the saved license or trial key from this browser?');
      if (!confirmed) return;
      await new Promise((/** @type {(value?: void) => void} */ resolve) => {
        chrome.runtime.sendMessage({ action: 'logoutLicense' }, () => resolve());
      });
      this.accessState = null;
      this.handleAccessLost({ status: 'unauthenticated' });
    });

    // Sidebar nav
    document.querySelectorAll('.nav-btn').forEach(btn => {
      if (!(btn instanceof HTMLElement)) return;
      btn.addEventListener('click', () => this.switchSidebarPanel(btn.dataset.panel || '', btn));
    });

    // Extraction buttons
    this.byId('startExtraction')?.addEventListener('click', () => this.startExtraction());
    this.byId('stopExtraction')?.addEventListener('click', () => this.stopExtraction());
    this.byId('saveAllLeads')?.addEventListener('click', () => this.saveAllExtractedLeads());
    this.byId('refreshLeads')?.addEventListener('click', () => this.refreshData());

    // Settings
    this.byId('maxLeadsInput')?.addEventListener('change', () => this.saveSettings());
    this.byId('noLimitInput')?.addEventListener('change', () => {
      const maxLeads = this.inputEl('maxLeadsInput');
      const noLimit = this.inputEl('noLimitInput');
      if (maxLeads && noLimit) maxLeads.disabled = noLimit.checked;
      this.saveSettings();
    });
    this.byId('requirePhoneInput')?.addEventListener('change', () => this.saveSettings());
    this.byId('requireWebsiteInput')?.addEventListener('change', () => this.saveSettings());
    this.byId('requireEmailInput')?.addEventListener('change', () => this.saveSettings());
    this.byId('countryCodeInput')?.addEventListener('blur', () => this.saveSettings());

    // WhatsApp message textarea (in-sidebar)
    const waTextarea = this.textareaEl('whatsAppMessageInput');
    if (waTextarea) {
      waTextarea.addEventListener('change', () => this.onWhatsAppMessageChange());
      waTextarea.addEventListener('blur', () => this.onWhatsAppMessageChange());
    }

    // Quick template selector dropdown
    const quickSel = this.selectEl('templateQuickSelect');
    if (quickSel) {
      quickSel.addEventListener('change', async () => {
        this.defaultTemplateId = quickSel.value;
        await LeadStorage.setDefaultTemplateId(quickSel.value);
        this.loadTemplateIntoTextarea(quickSel.value);
        this.renderTemplates();
        this.showToast('Template switched', 'success');
      });
    }

    // Gear button → open templates panel
    this.byId('openTemplatesPanel')?.addEventListener('click', () => {
      const btn = this.byId('navTemplates');
      this.switchSidebarPanel('templatesPanel', btn);
    });

    // Inline var chips (in extraction panel)
    document.querySelectorAll('.var-chips-inline .var-chip').forEach(chip => {
      if (!(chip instanceof HTMLElement)) return;
      chip.addEventListener('click', () => {
        const ta = this.textareaEl('whatsAppMessageInput');
        if (!ta) return;
        const variable = chip.dataset.var || '';
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? ta.value.length;
        ta.value = ta.value.substring(0, start) + variable + ta.value.substring(end);
        ta.selectionStart = ta.selectionEnd = start + variable.length;
        ta.focus();
      });
    });

    // Tabs
    this.byId('tabExtracted')?.addEventListener('click', () => this.handleTabClick('extracted'));
    this.byId('tabSaved')?.addEventListener('click', () => this.handleTabClick('saved'));

    // Search (extracted)
    const searchInput = this.inputEl('searchInput');
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.byId('clearSearch')?.classList.toggle('hidden', !searchInput.value);
      this.applyFilters();
    });
    this.byId('clearSearch')?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      this.searchQuery = '';
      this.byId('clearSearch')?.classList.add('hidden');
      this.applyFilters();
    });

    // Search (saved)
    const savedSearchInput = this.inputEl('savedSearchInput');
    savedSearchInput?.addEventListener('input', () => {
      this.savedSearchQuery = savedSearchInput.value;
      this.byId('clearSavedSearch')?.classList.toggle('hidden', !savedSearchInput.value);
      this.renderSavedLeads();
    });
    this.byId('clearSavedSearch')?.addEventListener('click', () => {
      if (savedSearchInput) savedSearchInput.value = '';
      this.savedSearchQuery = '';
      this.byId('clearSavedSearch')?.classList.add('hidden');
      this.renderSavedLeads();
    });

    // Filter
    const filterSelect = this.selectEl('filterSelect');
    filterSelect?.addEventListener('change', () => {
      this.typeFilter = filterSelect.value;
      this.applyFilters();
    });

    // Scroll-based pagination
    this.byId('leadsList')?.addEventListener('scroll', () => this.handleLeadListScroll());

    // Lead actions (event delegation)
    this.byId('leadsList')?.addEventListener('click', e => this.handleLeadActionClick(e));
    this.byId('savedList')?.addEventListener('click', e => this.handleSavedLeadClick(e));

    // Export & Clear
    this.byId('exportCSV')?.addEventListener('click', () => this.exportCSV());
    this.byId('exportExcel')?.addEventListener('click', () => this.exportExcel());
    this.byId('clearAll')?.addEventListener('click', () => this.clearAll());

    // Modals
    this.byId('closeModal')?.addEventListener('click', () => this.closeModal('addLeadModal'));
    this.byId('addLeadForm')?.addEventListener('submit', e => this.handleAddLead(e));
    this.byId('closeEditModal')?.addEventListener('click', () => this.closeModal('editLeadModal'));
    this.byId('editLeadForm')?.addEventListener('submit', e => this.handleEditLead(e));
    this.byId('closeSavedLeadViewModal')?.addEventListener('click', () => this.closeModal('savedLeadViewModal'));

    // Confirm dialog
    this.byId('confirmOk')?.addEventListener('click', () => {
      if (this._confirmResolve) { this._confirmResolve(true); this._confirmResolve = null; }
      this.closeModal('confirmModal');
    });
    this.byId('confirmCancel')?.addEventListener('click', () => {
      if (this._confirmResolve) { this._confirmResolve(false); this._confirmResolve = null; }
      this.closeModal('confirmModal');
    });

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      if (!(overlay instanceof HTMLElement)) return;
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          overlay.style.display = 'none';
          if (this._confirmResolve) { this._confirmResolve(false); this._confirmResolve = null; }
        }
      });
    });

    // Templates panel
    this.byId('addTemplateBtn')?.addEventListener('click', () => this.openTemplateEditor(null));
    this.byId('saveTemplateBtn')?.addEventListener('click', () => this.saveTemplate());
    this.byId('cancelTemplateBtn')?.addEventListener('click', () => this.closeTemplateEditor());

    // Variable chips
    document.querySelectorAll('.var-chip').forEach(chip => {
      if (!(chip instanceof HTMLElement)) return;
      chip.addEventListener('click', () => this.insertVar(chip.dataset.var || ''));
    });
  }

  // ── Sidebar Nav ───────────────────────────────────────────────────────────
  /**
   * @param {string} panelId
   * @param {HTMLElement | null} btn
   */
  switchSidebarPanel(panelId, btn) {
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    if (panelId) this.byId(panelId)?.classList.add('active');
    btn?.classList.add('active');
    this.activeSidebarPanel = panelId;
  }

  // ── Extraction ────────────────────────────────────────────────────────────
  async startExtraction() {
    if (this.isExtracting) return;

    try {
      // ── Live Backend Access Verification Before Extraction ───────────────────────
      if (!(await this.ensureValidAccess())) {
        return;
      }
      // ───────────────────────────────────────────────────────────────────────────

      const tab = await this.getExtractionTab();
      if (!tab?.id) throw new Error('No active tab found. Open a web page or Google Maps search first.');

      await this.saveSettings();
      if (!this.extractionSettings?.countryCode) throw new Error('Please enter a valid country code (e.g. 91)');

      this.isExtracting = true;
      this.currentSessionSaved = 0;
      this.currentTabId = tab.id;
      this.activeSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.extractionStartTime = Date.now();

      this.updateExtractionButtons();
      this.showProgress(0);
      this.showLiveStats(true);
      this.setExtractionStatus('Starting extraction…');
      this.updateLiveStats({ totalFound: 0, totalSaved: 0, totalFailed: 0 });
      this.startElapsedTimer(this.extractionStartTime);

      // Notify background (which also re-verifies backend access)
      const bgStart = await chrome.runtime.sendMessage({
        action: 'extractionStarted',
        sessionId: this.activeSessionId,
        tabId: tab.id
      });
      if (bgStart && bgStart.ok === false) {
        this.handleAccessLost(bgStart.licenseState || { status: 'expired', error: bgStart.error });
        throw new Error(bgStart.error || 'Access denied');
      }

      // Send extract command to content script with retry mechanism
      /** @type {any} */
      let response;
      let retries = 3;
      while (retries > 0) {
        try {
          response = await chrome.tabs.sendMessage(tab.id, {
            action: 'extract',
            sessionId: this.activeSessionId,
            options: {
              maxLeads: this.extractionSettings.noLimit ? null : this.extractionSettings.limit,
              noLimit: this.extractionSettings.noLimit,
              requirePhone: this.extractionSettings.requirePhone
            }
          });
          break; // Success
        } catch (err) {
          retries--;
          const errMsg = err instanceof Error ? err.message : String(err || '');
          if (retries === 0 || !errMsg.includes('Receiving end does not exist')) {
            throw err;
          }
          await new Promise(r => setTimeout(r, 1000)); // Wait 1s and retry
        }
      }

      if (response?.error) throw new Error(response.error);

      // Handle batch returned on completion (for standard pages)
      if (Array.isArray(response?.leads) && response.leads.length > 0) {
        const saved = await this.ingestLeads(response.leads);
        this.currentSessionSaved += saved;
      }

      await this.loadLeads();
      this.renderAll();
      this.showProgress(100);

      const finalCount = response?.savedCount ?? this.currentSessionSaved;
      let statusText;
      if (finalCount > 0) {
        statusText = response?.stopped
          ? `Stopped after saving ${finalCount} leads`
          : `Completed — ${finalCount} leads extracted`;
        this.showToast(`Extracted ${finalCount} leads`, 'success');
      } else {
        statusText = 'No leads found. Try scrolling Maps results first, or uncheck "Phone Only".';
        this.showToast('No leads found', 'warning');
      }

      this.setExtractionStatus(statusText);
      await chrome.runtime.sendMessage({
        action: 'extractionCompleted',
        statusText,
        totalSaved: this.currentSessionSaved
      }).catch(() => { });

    } catch (error) {
      console.error('[Popup] Extraction error:', error);
      let msg = (error instanceof Error && error.message) ? error.message : 'Extraction failed';
      if (msg.includes('Receiving end does not exist')) {
        msg = 'Could not connect to the page. Please refresh the page (F5) and try again.';
      }
      this.setExtractionStatus(msg);
      this.showToast(msg, 'error');
      await chrome.runtime.sendMessage({ action: 'extractionStopped', statusText: msg }).catch(() => { });
    } finally {
      this.isExtracting = false;
      this.activeSessionId = null;
      this.currentTabId = null;
      this.currentSessionSaved = 0;
      this.stopElapsedTimer();
      this.updateExtractionButtons();
      setTimeout(() => this.hideProgress(), 1500);
    }
  }

  async stopExtraction() {
    if (!this.isExtracting) return;

    try {
      if (this.currentTabId) {
        await chrome.tabs.sendMessage(this.currentTabId, {
          action: 'stopExtraction',
          sessionId: this.activeSessionId
        }).catch(() => { });
      }
    } catch (err) {
      console.warn('[Popup] Stop extraction error:', err);
    }

    await chrome.runtime.sendMessage({ action: 'extractionStopped', statusText: 'Stopped by user' }).catch(() => { });

    this.isExtracting = false;
    this.activeSessionId = null;
    this.stopElapsedTimer();
    this.updateExtractionButtons();
    this.setExtractionStatus('Extraction stopped by user');
    setTimeout(() => this.hideProgress(), 800);
  }

  updateExtractionButtons() {
    const startBtn = this.buttonEl('startExtraction');
    const stopBtn = this.byId('stopExtraction');
    const spinner = this.byId('extractionSpinner');
    const icon = document.querySelector('.btn-icon-start');
    const text = this.byId('startExtractionText');

    if (this.isExtracting) {
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.classList.add('is-extracting');
      }
      if (spinner) spinner.style.display = 'block';
      if (icon instanceof HTMLElement) icon.style.display = 'none';
      if (text) text.textContent = 'Running…';
      stopBtn?.classList.remove('hidden');
    } else {
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.classList.remove('is-extracting');
      }
      if (spinner) spinner.style.display = 'none';
      if (icon instanceof HTMLElement) icon.style.display = '';
      if (text) text.textContent = 'Start Discovery';
      stopBtn?.classList.add('hidden');
    }

    // Status indicator
    const indicator = this.byId('statusIndicator');
    if (indicator) {
      indicator.className = 'status-indicator';
      if (this.isExtracting) indicator.classList.add('running');
    }
  }

  // ── Lead Ingestion ────────────────────────────────────────────────────────
  /**
   * @param {Record<string, any>[]} [rawLeads]
   * @returns {Promise<number>}
   */
  async ingestLeads(rawLeads = []) {
    let saved = 0;
    for (const rawLead of rawLeads) {
      /** @type {StoredLead} */
      const preparedLead = {
        ...this.sanitizeLeadForStorage(rawLead),
        id: this.generateId(),
        type: 'extracted',
        contacted: false,
        contactedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: rawLead.source || ''
      };

      if (this.isDuplicateLead(preparedLead)) continue;

      try {
        await LeadStorage.addLead(preparedLead);
        this.leads.unshift(preparedLead);
        saved++;
      } catch (err) {
        console.warn('[Popup] Failed to save lead:', err);
      }
    }

    this.extractedLeads = this.leads.filter(l => !l.type || l.type === 'extracted');
    this.savedLeads = this.leads.filter(l => l.type === 'saved');
    this.applyFilters();
    this.updateBadges();
    return saved;
  }

  /**
   * @param {Partial<StoredLead>} candidate
   * @returns {boolean}
   */
  isDuplicateLead(candidate) {
    const phone = candidate.phone?.replace(/\D/g, '');
    const email = candidate.email?.toLowerCase().trim();
    const nameKey = `${candidate.company || ''}_${candidate.name || ''}`.toLowerCase().trim();

    return this.leads.some(lead => {
      const lPhone = lead.phone?.replace(/\D/g, '');
      const lEmail = lead.email?.toLowerCase().trim();
      const lKey = `${lead.company || ''}_${lead.name || ''}`.toLowerCase().trim();

      return (
        (phone && lPhone && phone.length >= 10 && phone === lPhone) ||
        (email && lEmail && email === lEmail) ||
        (nameKey !== '_' && nameKey.length > 2 && nameKey === lKey)
      );
    });
  }

  // ── Deduplication ─────────────────────────────────────────────────────────
  async deduplicate() {
    const confirmed = await this.confirm('Remove Duplicates', 'This will remove duplicate entries. Continue?');
    if (!confirmed) return;

    const originalCount = this.leads.length;
    this.leads = Deduplicator.deduplicate(this.leads);
    const removedCount = originalCount - this.leads.length;

    await LeadStorage.clearAllLeads();
    for (const lead of this.leads) await LeadStorage.addLead(lead);

    await this.loadLeads();
    this.renderAll();
    this.showToast(`Removed ${removedCount} duplicate leads`, 'success');
  }

  // ── Save All Leads ────────────────────────────────────────────────────────
  async saveAllExtractedLeads() {
    try {
      if (!(await this.ensureValidAccess())) return;
      if (!this.extractedLeads || this.extractedLeads.length === 0) {
        this.showToast('No extracted leads to save', 'warning');
        return;
      }

      let savedCount = 0;
      this.showToast('Saving leads...', 'info');

      for (const lead of this.extractedLeads) {
        const updatedLead = { ...lead, type: 'saved', updatedAt: Date.now() };

        // Update in-memory
        const index = this.leads.findIndex(l => l.id === lead.id);
        if (index !== -1) {
          this.leads[index] = updatedLead;
        }
        savedCount++;
      }

      if (savedCount > 0) {
        // Automatic Deduplication
        this.leads = Deduplicator.deduplicate(this.leads);

        // Always rewrite to DB to ensure consistency and avoid partial state bugs
        await LeadStorage.clearAllLeads();
        for (const lead of this.leads) {
          // Use updateLead (which uses put) instead of addLead to avoid ConstraintErrors
          await LeadStorage.updateLead(lead);
        }

        this.extractedLeads = this.leads.filter(l => !l.type || l.type === 'extracted');
        this.savedLeads = this.leads.filter(l => l.type === 'saved');

        this.renderAll();
        this.showToast(`Successfully saved ${savedCount} leads`, 'success');
        this.handleTabClick('saved');
      } else {
        this.showToast('All leads are already saved', 'info');
      }
    } catch (err) {
      console.error('[Popup] Save error:', err);
      this.showToast('Error saving leads. Please try again.', 'error');
    }
  }

  // ── Refresh ───────────────────────────────────────────────────────────────
  async refreshData() {
    const btn = this.byId('refreshLeads');
    btn?.classList.add('spinning');
    try {
      await this.loadLeads();
      this.renderAll();
      this.showToast('Data refreshed', 'success');
    } finally {
      setTimeout(() => btn?.classList.remove('spinning'), 600);
    }
  }

  // ── Tab Switching ─────────────────────────────────────────────────────────
  /**
   * @param {'extracted' | 'saved'} tabId
   */
  handleTabClick(tabId) {
    this.activeTab = tabId;
    this.byId('tabExtracted')?.classList.toggle('active', tabId === 'extracted');
    this.byId('tabSaved')?.classList.toggle('active', tabId === 'saved');
    this.byId('extractedLeadsContainer')?.classList.toggle('active', tabId === 'extracted');
    this.byId('savedLeadsContainer')?.classList.toggle('active', tabId === 'saved');
    this.applyFilters();
    this.updateBadges();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  renderAll() {
    this.applyFilters();
    this.updateBadges();
  }

  applyFilters() {
    const searchTerm = this.searchQuery.toLowerCase().trim();
    const sourceLeads = this.activeTab === 'extracted' ? this.extractedLeads : this.savedLeads;

    const filtered = sourceLeads.filter(lead => {
      const matchesSearch = !searchTerm || [
        lead.name, lead.email, lead.phone, lead.company,
        lead.jobTitle, lead.website, lead.address, lead.category
      ].some(v => v?.toLowerCase().includes(searchTerm));

      if (!matchesSearch) return false;

      switch (this.typeFilter) {
        case 'email': return Boolean(lead.email);
        case 'phone': return Boolean(lead.phone);
        case 'company': return Boolean(lead.company);
        case 'rating': return this.getRatingValue(lead.rating) > 0;
        case 'no-website': return !lead.website;
        case 'most-reviews': return this.getReviewsValue(lead.reviews) > 0;
        default: return true;
      }
    });

    this.filteredLeads = this.typeFilter === 'rating'
      ? filtered.sort((a, b) => this.getRatingValue(b.rating) - this.getRatingValue(a.rating))
      : this.typeFilter === 'most-reviews'
        ? filtered.sort((a, b) => this.getReviewsValue(b.reviews) - this.getReviewsValue(a.reviews))
        : filtered;

    if (this.activeTab === 'extracted') {
      this.renderLeads(true);
    } else {
      this.renderSavedLeads();
    }
  }

  /**
   * @param {boolean} [reset]
   */
  renderLeads(reset = false) {
    const container = this.byId('leadsList');
    const listStatus = this.byId('listStatus');
    if (!container || !listStatus) return;

    if (this.filteredLeads.length === 0) {
      const msg = this.extractedLeads.length > 0
        ? '<div class="empty-icon">🔎</div><p>No leads match the current filters.</p>'
        : '<div class="empty-icon">📂</div><p>No leads yet. Start a scan to find opportunities.</p>';
      container.innerHTML = `<div class="empty-state">${msg}</div>`;
      listStatus.textContent = '';
      this.renderedLeadCount = 0;
      return;
    }

    if (reset) {
      this.renderedLeadCount = 0;
      container.innerHTML = '';
      container.scrollTop = 0;
    }

    const nextBatch = this.filteredLeads.slice(this.renderedLeadCount, this.renderedLeadCount + this.renderBatchSize);
    if (nextBatch.length === 0) { this.updateListStatus(); return; }

    const markup = nextBatch.map(lead => this.renderLeadRow(lead)).join('');
    container.insertAdjacentHTML('beforeend', markup);
    this.renderedLeadCount += nextBatch.length;
    this.updateListStatus();

    // Auto-load if not scrollable
    if (container.scrollHeight <= container.clientHeight && this.renderedLeadCount < this.filteredLeads.length) {
      this.renderLeads();
    }
  }

  /**
   * @param {StoredLead} lead
   * @returns {string}
   */
  renderLeadRow(lead) {
    const hasWA = this.hasWhatsAppNumber(lead);
    const safeId = this.escapeHtml(lead.id);
    const ratingHtml = lead.rating ? `<span class="lead-rating">⭐ ${this.escapeHtml(lead.rating)}${lead.reviews ? ` (${this.escapeHtml(lead.reviews)})` : ''}</span>` : '';
    const categoryHtml = lead.category ? `<span class="lead-category">${this.escapeHtml(lead.category.slice(0, 30))}</span>` : '';

    return `
      <div class="lead-row ${lead.contacted ? 'contacted' : ''}" data-id="${safeId}">
        <div class="lead-info">
          <div class="lead-name">${this.escapeHtml(lead.name || 'Unknown Business')}</div>
          <div class="lead-details">
            ${lead.phone ? `<span class="detail-chip phone">📞 ${this.escapeHtml(lead.phone)}</span>` : ''}
            ${lead.website ? `<span class="detail-chip website">🌐 ${this.escapeHtml(lead.website.replace(/^https?:\/\//, '').slice(0, 30))}</span>` : ''}
            ${lead.address ? `<span class="detail-chip address">📍 ${this.escapeHtml(lead.address.slice(0, 40))}</span>` : ''}
            ${ratingHtml}${categoryHtml}
          </div>
          <div class="lead-meta">
            <span class="status-badge ${lead.contacted ? 'contacted' : ''}">
              ${lead.contacted ? '✓ Contacted' : '○ Not Contacted'}
            </span>
            ${lead.source ? `<span class="source-badge" title="${this.escapeHtml(lead.source)}">📍 ${this.escapeHtml(lead.source.slice(0, 20))}</span>` : ''}
          </div>
        </div>
        <div class="lead-actions">
          <button type="button" class="lead-action-btn whatsapp ${hasWA ? '' : 'disabled'}" title="${hasWA ? 'Send WhatsApp' : 'No phone number'}" data-action="whatsapp" data-id="${safeId}" ${hasWA ? '' : 'disabled'}>
            ${this.whatsappIconSvg()}
          </button>
          <button type="button" class="lead-action-btn contact ${lead.contacted ? 'active' : ''}" title="${lead.contacted ? 'Mark as not contacted' : 'Mark as contacted'}" data-action="contact" data-id="${safeId}">
            ${lead.contacted ? '✓' : '○'}
          </button>
          <button type="button" class="lead-action-btn edit" title="Edit" data-action="edit" data-id="${safeId}">✏️</button>
          <button type="button" class="lead-action-btn delete" title="Delete" data-action="delete" data-id="${safeId}">🗑️</button>
        </div>
      </div>
    `;
  }

  renderSavedLeads() {
    const container = this.byId('savedList');
    if (!container) return;
    const query = this.savedSearchQuery.toLowerCase().trim();

    const filtered = this.savedLeads.filter(lead => {
      if (!query) return true;
      return [lead.name, lead.company, lead.phone, lead.email, lead.address].some(
        v => v?.toLowerCase().includes(query)
      );
    });

    if (filtered.length === 0) {
      const msg = this.savedLeads.length > 0
        ? '<div class="empty-icon">🔎</div><p>No saved leads match your search.</p>'
        : '<div class="empty-icon">💾</div><p>No saved leads yet. Use "Save Page" to add leads here.</p>';
      container.innerHTML = `<div class="empty-state">${msg}</div>`;
      return;
    }

    container.innerHTML = filtered.map(lead => {
      const safeId = this.escapeHtml(lead.id);
      return `
      <div class="saved-lead-row" data-id="${safeId}">
        <div class="saved-lead-info">
          <div class="saved-lead-name">${this.escapeHtml(lead.name || 'Unknown')}</div>
          <div class="saved-lead-sub">
            ${lead.phone ? `<span>📞 ${this.escapeHtml(lead.phone)}</span>` : ''}
            ${lead.company ? `<span>🏢 ${this.escapeHtml(lead.company)}</span>` : ''}
          </div>
        </div>
        <div class="saved-lead-actions">
          <button type="button" class="lead-action-btn whatsapp ${this.hasWhatsAppNumber(lead) ? '' : 'disabled'}" title="${this.hasWhatsAppNumber(lead) ? 'Send WhatsApp' : 'No phone number'}" data-action="whatsapp" data-id="${safeId}" ${this.hasWhatsAppNumber(lead) ? '' : 'disabled'}>
            ${this.whatsappIconSvg()}
          </button>
          <button class="lead-action-btn contact ${lead.contacted ? 'active' : ''}" data-action="contact" data-id="${safeId}" title="Toggle contacted">
            ${lead.contacted ? '✓' : '○'}
          </button>
          <button class="lead-action-btn edit" data-action="edit-saved" data-id="${safeId}" title="Edit">✏️</button>
          <button class="lead-action-btn delete" data-action="delete" data-id="${safeId}" title="Delete">🗑️</button>
        </div>
      </div>
    `;
    }).join('');
  }

  handleLeadListScroll() {
    const container = this.byId('leadsList');
    if (!container) return;
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining <= 60) this.renderLeads();
  }

  /**
   * @param {MouseEvent} event
   */
  handleLeadActionClick(event) {
    if (!(event.target instanceof Element)) return;
    const btn = event.target.closest('button[data-action][data-id]');
    if (!(btn instanceof HTMLButtonElement) || btn.disabled) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action && id) this.dispatchLeadAction(action, id);
  }

  /**
   * @param {MouseEvent} event
   */
  handleSavedLeadClick(event) {
    if (!(event.target instanceof Element)) return;
    const btn = event.target.closest('button[data-action][data-id]');
    if (btn instanceof HTMLButtonElement && !btn.disabled) {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action && id) this.dispatchLeadAction(action, id);
      return;
    }
    // Click on row → open detail
    const row = event.target.closest('.saved-lead-row[data-id]');
    if (row instanceof HTMLElement && row.dataset.id) this.showSavedLeadDetails(row.dataset.id);
  }

  /**
   * @param {string} action
   * @param {string} id
   */
  dispatchLeadAction(action, id) {
    switch (action) {
      case 'whatsapp': this.openWhatsApp(id); break;
      case 'contact': this.toggleContacted(id); break;
      case 'edit':
      case 'edit-saved': this.editLead(id); break;
      case 'delete': this.deleteLead(id); break;
    }
  }

  updateListStatus() {
    const listStatus = this.byId('listStatus');
    if (!listStatus) return;
    if (!this.filteredLeads.length) { listStatus.textContent = ''; return; }
    const hasMore = this.renderedLeadCount < this.filteredLeads.length;
    listStatus.textContent = hasMore
      ? `Showing ${this.renderedLeadCount} of ${this.filteredLeads.length} leads`
      : `All ${this.filteredLeads.length} leads shown`;
  }

  updateBadges() {
    const extractedBadge = this.byId('extractedBadge');
    const savedBadge = this.byId('savedBadge');
    if (extractedBadge) extractedBadge.textContent = String(this.extractedLeads.length);
    if (savedBadge) savedBadge.textContent = String(this.savedLeads.length);
  }

  // ── Live Stats ─────────────────────────────────────────────────────────────
  /**
   * @param {{ totalFound?: number, totalSaved?: number, totalFailed?: number }} stats
   */
  updateLiveStats({ totalFound, totalSaved, totalFailed }) {
    const statFound = this.byId('statFound');
    const statSaved = this.byId('statSaved');
    const statFailed = this.byId('statFailed');
    if (statFound) statFound.textContent = String(totalFound ?? 0);
    if (statSaved) statSaved.textContent = String(totalSaved ?? 0);
    if (statFailed) statFailed.textContent = String(totalFailed ?? 0);
  }

  /**
   * @param {boolean} show
   */
  showLiveStats(show) {
    const grid = this.byId('liveStatsGrid');
    if (grid) grid.style.display = show ? 'grid' : 'none';
  }

  /**
   * @param {number | null | undefined} startTime
   */
  startElapsedTimer(startTime) {
    this.stopElapsedTimer();
    const update = () => {
      const elapsed = Math.floor((Date.now() - (startTime || Date.now())) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      const elapsedEl = this.byId('statElapsed');
      if (elapsedEl) elapsedEl.textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
    };
    update();
    this.elapsedTimer = setInterval(update, 1000);
  }

  stopElapsedTimer() {
    if (this.elapsedTimer !== null) { clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
  }

  /**
   * @param {string[]} errors
   */
  showErrorLog(errors) {
    const log = this.byId('errorLog');
    const list = this.byId('errorLogList');
    if (!log || !list) return;
    if (errors.length === 0) { log.classList.add('hidden'); return; }
    log.classList.remove('hidden');
    list.innerHTML = errors.slice(-5).map(e => `<li>${this.escapeHtml(String(e))}</li>`).join('');
  }

  // ── Lead Detail (Saved) ───────────────────────────────────────────────────
  /**
   * @param {string} id
   */
  showSavedLeadDetails(id) {
    const lead = this.leads.find(l => l.id === id);
    if (!lead) return;

    const safeId = this.escapeHtml(lead.id);
    const hasSafeWebsite = lead.website && /^https?:\/\//i.test(lead.website.trim());
    const content = this.byId('savedLeadViewContent');
    if (!content) return;

    const contactedLabel = lead.contacted
      ? (lead.contactedAt ? `✓ Contacted on ${new Date(lead.contactedAt).toLocaleDateString()}` : '✓ Contacted')
      : '○ Not Contacted';

    content.innerHTML = `
      <div class="lead-detail-view">
        <div class="detail-name">${this.escapeHtml(lead.name || 'Unknown')}</div>
        <div class="detail-fields">
          ${lead.phone ? `<div class="detail-field"><span class="detail-label">📞 Phone</span><span class="detail-val">${this.escapeHtml(lead.phone)}</span></div>` : ''}
          ${lead.email ? `<div class="detail-field"><span class="detail-label">✉️ Email</span><span class="detail-val">${this.escapeHtml(lead.email)}</span></div>` : ''}
          ${lead.company ? `<div class="detail-field"><span class="detail-label">🏢 Company</span><span class="detail-val">${this.escapeHtml(lead.company)}</span></div>` : ''}
          ${lead.website ? `<div class="detail-field"><span class="detail-label">🌐 Website</span>${hasSafeWebsite ? `<a href="${this.escapeHtml(lead.website.trim())}" target="_blank" rel="noopener noreferrer" class="detail-link">${this.escapeHtml(lead.website)}</a>` : `<span class="detail-val">${this.escapeHtml(lead.website)}</span>`}</div>` : ''}
          ${lead.address ? `<div class="detail-field"><span class="detail-label">📍 Address</span><span class="detail-val">${this.escapeHtml(lead.address)}</span></div>` : ''}
          ${lead.category ? `<div class="detail-field"><span class="detail-label">🏷 Category</span><span class="detail-val">${this.escapeHtml(lead.category)}</span></div>` : ''}
          ${lead.rating ? `<div class="detail-field"><span class="detail-label">⭐ Rating</span><span class="detail-val">${this.escapeHtml(lead.rating)} (${this.escapeHtml(String(lead.reviews || 0))} reviews)</span></div>` : ''}
          <div class="detail-field">
            <span class="detail-label">Status</span>
            <span class="status-badge ${lead.contacted ? 'contacted' : ''}">
              ${contactedLabel}
            </span>
          </div>
        </div>
        <div class="detail-actions">
          ${this.hasWhatsAppNumber(lead) ? `<button class="lead-action-btn whatsapp" data-action="whatsapp" data-id="${safeId}" title="Send WhatsApp">${this.whatsappIconSvg()} WhatsApp</button>` : ''}
          <button class="lead-action-btn contact ${lead.contacted ? 'active' : ''}" data-action="contact" data-id="${safeId}">${lead.contacted ? '✓ Contacted' : '○ Mark Contacted'}</button>
          <button class="lead-action-btn edit" data-action="edit-saved" data-id="${safeId}">✏️ Edit</button>
          <button class="lead-action-btn delete" data-action="delete" data-id="${safeId}">🗑️ Delete</button>
        </div>
      </div>
    `;

    content.querySelector('.detail-actions')?.addEventListener('click', e => {
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest('button[data-action][data-id]');
      if (!(btn instanceof HTMLElement)) return;
      const action = btn.dataset.action;
      const targetId = btn.dataset.id;
      if (!action || !targetId) return;
      this.dispatchLeadAction(action, targetId);
      if (action === 'delete') this.closeModal('savedLeadViewModal');
      else if (action === 'contact') {
        this.closeModal('savedLeadViewModal');
        setTimeout(() => this.showSavedLeadDetails(targetId), 300);
      }
    });

    const modal = this.byId('savedLeadViewModal');
    if (modal) modal.style.display = 'flex';
  }

  // ── Lead CRUD ─────────────────────────────────────────────────────────────
  /**
   * @param {string} id
   */
  async deleteLead(id) {
    const confirmed = await this.confirm('Delete Lead', 'Delete this lead permanently?');
    if (!confirmed) return;
    await LeadStorage.deleteLead(id);
    await this.loadLeads();
    this.renderAll();
    this.showToast('Lead deleted', 'success');
  }

  /**
   * @param {HTMLFormElement} form
   * @param {string} fieldName
   * @returns {HTMLInputElement | null}
   */
  getFormInput(form, fieldName) {
    const item = form.elements.namedItem(fieldName);
    return item instanceof HTMLInputElement ? item : null;
  }

  /**
   * @param {string} id
   */
  editLead(id) {
    const lead = this.leads.find(l => l.id === id);
    if (!lead) return;

    const form = /** @type {HTMLFormElement | null} */ (document.getElementById('editLeadForm'));
    if (!form) return;

    const idInput = this.getFormInput(form, 'id');
    const nameInput = this.getFormInput(form, 'name');
    const emailInput = this.getFormInput(form, 'email');
    const phoneInput = this.getFormInput(form, 'phone');
    const companyInput = this.getFormInput(form, 'company');
    const jobTitleInput = this.getFormInput(form, 'jobTitle');
    const websiteInput = this.getFormInput(form, 'website');
    const addressInput = this.getFormInput(form, 'address');

    if (idInput) idInput.value = lead.id;
    if (nameInput) nameInput.value = lead.name || '';
    if (emailInput) emailInput.value = lead.email || '';
    if (phoneInput) phoneInput.value = lead.phone || '';
    if (companyInput) companyInput.value = lead.company || '';
    if (jobTitleInput) jobTitleInput.value = lead.jobTitle || '';
    if (websiteInput) websiteInput.value = lead.website || '';
    if (addressInput) addressInput.value = lead.address || '';

    const editModal = this.byId('editLeadModal');
    if (editModal) editModal.style.display = 'flex';
  }

  /**
   * @param {SubmitEvent} e
   */
  async handleEditLead(e) {
    e.preventDefault();
    if (!(e.target instanceof HTMLFormElement)) return;
    const form = e.target;
    const id = this.getFormInput(form, 'id')?.value || '';
    const existing = this.leads.find(l => l.id === id);
    if (!existing) { this.showToast('Lead not found', 'error'); return; }

    /** @type {StoredLead} */
    const updatedLead = {
      ...existing,
      name: (this.getFormInput(form, 'name')?.value || '').trim(),
      email: (this.getFormInput(form, 'email')?.value || '').trim(),
      phone: (this.getFormInput(form, 'phone')?.value || '').trim(),
      company: (this.getFormInput(form, 'company')?.value || '').trim(),
      jobTitle: (this.getFormInput(form, 'jobTitle')?.value || '').trim(),
      website: (this.getFormInput(form, 'website')?.value || '').trim(),
      address: (this.getFormInput(form, 'address')?.value || '').trim(),
      updatedAt: Date.now()
    };

    await LeadStorage.updateLead(updatedLead);
    await this.loadLeads();
    this.renderAll();
    this.closeModal('editLeadModal');
    this.showToast('Lead updated', 'success');
  }

  /**
   * @param {SubmitEvent} e
   */
  async handleAddLead(e) {
    e.preventDefault();
    if (!(e.target instanceof HTMLFormElement)) return;
    const form = e.target;

    /** @type {StoredLead} */
    const newLead = {
      id: this.generateId(),
      name: (this.getFormInput(form, 'name')?.value || '').trim(),
      email: (this.getFormInput(form, 'email')?.value || '').trim(),
      phone: (this.getFormInput(form, 'phone')?.value || '').trim(),
      company: (this.getFormInput(form, 'company')?.value || '').trim(),
      jobTitle: (this.getFormInput(form, 'jobTitle')?.value || '').trim(),
      website: (this.getFormInput(form, 'website')?.value || '').trim(),
      address: (this.getFormInput(form, 'address')?.value || '').trim(),
      type: 'saved',
      contacted: false,
      contactedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'Manual'
    };

    if (this.isDuplicateLead(newLead)) {
      this.showToast('A lead with this info already exists', 'warning');
      return;
    }

    await LeadStorage.addLead(newLead);
    await this.loadLeads();
    this.renderAll();
    this.closeModal('addLeadModal');
    this.showToast('Lead added', 'success');
    form.reset();
  }

  async clearAll() {
    const confirmed = await this.confirm('Clear All Leads', 'This will permanently delete ALL leads. This cannot be undone.');
    if (!confirmed) return;

    await LeadStorage.clearAllLeads();
    this.leads = [];
    this.extractedLeads = [];
    this.savedLeads = [];
    this.filteredLeads = [];
    this.renderAll();
    this.updateBadges();
    this.showToast('All leads cleared', 'success');
  }

  // ── Toggle Contacted ──────────────────────────────────────────────────────
  /**
   * @param {string} id
   * @param {boolean | null} [forceValue]
   */
  async toggleContacted(id, forceValue = null) {
    const lead = this.leads.find(l => l.id === id);
    if (!lead) return;

    const newValue = forceValue !== null ? forceValue : !lead.contacted;
    /** @type {StoredLead} */
    const updatedLead = {
      ...lead,
      contacted: newValue,
      contactedAt: newValue ? Date.now() : null,
      updatedAt: Date.now()
    };

    await LeadStorage.updateLead(updatedLead);
    this.leads = this.leads.map(l => l.id === id ? updatedLead : l);
    this.extractedLeads = this.leads.filter(l => !l.type || l.type === 'extracted');
    this.savedLeads = this.leads.filter(l => l.type === 'saved');
    this.applyFilters();
    this.showToast(newValue ? 'Marked as contacted' : 'Marked as not contacted', 'success');
  }

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  /**
   * @param {string} id
   */
  async openWhatsApp(id) {
    if (!(await this.ensureValidAccess())) return;
    const lead = this.leads.find(l => l.id === id);
    if (!lead || !this.hasWhatsAppNumber(lead)) {
      this.showToast('No valid phone number for WhatsApp', 'error');
      return;
    }

    await this.saveSettings();
    const template = this.getSelectedTemplate();
    const url = this.buildWhatsAppUrl(lead, template.body);

    if (!url) {
      this.showToast('WhatsApp link could not be generated', 'error');
      return;
    }

    try {
      this.showToast('Opening WhatsApp…', 'info');
      chrome.runtime.sendMessage({ action: 'openWhatsAppAndSend', url }, (response) => {
        if (chrome.runtime.lastError || response?.error) {
          console.warn('[Popup] WhatsApp error:', response?.error || chrome.runtime.lastError?.message);
          this.showToast('WhatsApp opened (auto-send may not have worked)', 'warning');
        } else {
          this.showToast('WhatsApp opened successfully', 'success');
          this.toggleContacted(id, true);
        }
      });
    } catch (error) {
      window.open(url, '_blank', 'noopener');
      this.showToast('WhatsApp opened', 'success');
    }
  }

  /**
   * @param {StoredLead} lead
   * @param {string} [messageBody]
   * @returns {string}
   */
  buildWhatsAppUrl(lead, messageBody) {
    const phone = this.formatPhoneForWhatsApp(lead.phone);
    if (!phone || phone.length < 10) return '';

    const rawMessage = messageBody || this.getSelectedTemplate().body;
    const personalizedMessage = this.substitutePlaceholders(rawMessage, lead);
    return `https://wa.me/${phone}?text=${encodeURIComponent(personalizedMessage)}`;
  }

  /**
   * @param {string} message
   * @param {StoredLead} lead
   * @returns {string}
   */
  substitutePlaceholders(message, lead) {
    if (!message) return '';
    return message
      .replace(/\{\{name\}\}/gi, lead.name || '')
      .replace(/\{\{company\}\}/gi, lead.company || lead.name || '')
      .replace(/\{\{phone\}\}/gi, lead.phone || '')
      .replace(/\{\{address\}\}/gi, lead.address || '')
      .replace(/\{\{website\}\}/gi, lead.website || '')
      .replace(/\{\{category\}\}/gi, lead.category || '')
      .replace(/\{\{rating\}\}/gi, lead.rating || '')
      // Legacy bracket format compatibility
      .replace(/\[Name\]/gi, lead.name || '')
      .replace(/\[Business Name\]/gi, lead.company || lead.name || '')
      .replace(/\[Address\]/gi, lead.address || '')
      .replace(/\[Website\]/gi, lead.website || '')
      .replace(/\[Phone\]/gi, lead.phone || '')
      .replace(/\[Category\]/gi, lead.category || '')
      .replace(/\[Rating\]/gi, lead.rating || '')
      // Clean up blank lines caused by empty substitutions
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * @param {string | null | undefined} phone
   * @returns {string}
   */
  formatPhoneForWhatsApp(phone) {
    if (!phone) return '';
    const digits = String(phone).replace(/\D/g, '');
    if (!digits) return '';

    const countryCode = (this.extractionSettings?.countryCode || '').replace(/\D/g, '');
    if (countryCode && digits.startsWith(countryCode)) {
      let potentialLocal = digits.substring(countryCode.length);
      if (potentialLocal.startsWith('0') || potentialLocal.length >= 10) {
        potentialLocal = potentialLocal.replace(/^0+/, '');
        return countryCode + potentialLocal;
      }
    }

    const localPart = digits.replace(/^0+/, '');
    if (countryCode) {
      if (localPart.startsWith(countryCode) && localPart.length > countryCode.length) return localPart;
      return countryCode + localPart;
    }
    return localPart;
  }

  /**
   * @param {StoredLead} lead
   * @returns {boolean}
   */
  hasWhatsAppNumber(lead) {
    return this.formatPhoneForWhatsApp(lead.phone).length >= 10;
  }

  // ── Export ────────────────────────────────────────────────────────────────
  async exportCSV() {
    if (!(await this.ensureValidAccess())) return;
    if (this.leads.length === 0) { this.showToast('No leads to export', 'error'); return; }
    const data = this.leads.map(l => this.buildExportRow(l));
    const csv = Papa.unparse(data);
    this.downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }), 'leads.csv');
    this.showToast(`Exported ${this.leads.length} leads as CSV`, 'success');
  }

  async exportExcel() {
    if (!(await this.ensureValidAccess())) return;
    if (this.leads.length === 0) { this.showToast('No leads to export', 'error'); return; }
    const data = this.leads.map(l => this.buildExportRow(l));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const headers = Object.keys(data[0] || {});
    const waColIdx = headers.indexOf('WhatsApp URL');
    if (waColIdx >= 0) this.addWorksheetHyperlinks(worksheet, data, waColIdx, 'Open Chat');

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');

    worksheet['!cols'] = headers.map(key => ({
      wch: Math.max(key.length, ...data.map(row => String(row[key] || '').length))
    }));

    XLSX.writeFile(workbook, this.getTimestampedFilename('leads.xlsx'));
    this.showToast(`Exported ${this.leads.length} leads as Excel`, 'success');
  }

  /**
   * @param {StoredLead} lead
   * @returns {Record<string, any>}
   */
  buildExportRow(lead) {
    const template = this.getSelectedTemplate();
    return {
      Name: lead.name || '',
      Phone: lead.phone || '',
      Company: lead.company || '',
      Category: lead.category || '',
      Rating: lead.rating || '',
      Reviews: lead.reviews || '',
      Website: lead.website || '',
      Address: lead.address || '',
      Email: lead.email || '',
      'WhatsApp URL': this.buildWhatsAppUrl(lead, template.body),
      Type: lead.type || 'extracted',
      Contacted: lead.contacted ? 'Yes' : 'No',
      'Contacted Date': lead.contactedAt ? new Date(lead.contactedAt).toISOString() : '',
      'Added Date': lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : ''
    };
  }

  /**
   * @param {XLSX.WorkSheet} worksheet
   * @param {Record<string, any>[]} data
   * @param {number} columnIndex
   * @param {string} label
   */
  addWorksheetHyperlinks(worksheet, data, columnIndex, label) {
    data.forEach((row, rowIndex) => {
      const url = row['WhatsApp URL'];
      if (!url) return;
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex });
      worksheet[cellAddress] = { t: 's', v: label, l: { Target: url } };
    });
  }

  /**
   * @param {Blob} blob
   * @param {string} filename
   */
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.getTimestampedFilename(filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * @param {string} filename
   * @returns {string}
   */
  getTimestampedFilename(filename) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dotIdx = filename.lastIndexOf('.');
    return dotIdx >= 0
      ? `${filename.slice(0, dotIdx)}_${ts}${filename.slice(dotIdx)}`
      : `${filename}_${ts}`;
  }

  // ── Progress UI ───────────────────────────────────────────────────────────
  /**
   * @param {number} percent
   */
  showProgress(percent) {
    const container = this.byId('progressContainer');
    const fill = this.byId('progressFill');
    const text = this.byId('progressText');
    if (container) container.style.display = 'flex';
    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = `${Math.round(percent)}%`;
  }

  hideProgress() {
    const container = this.byId('progressContainer');
    if (container) container.style.display = 'none';
  }

  /**
   * @param {string} message
   */
  setExtractionStatus(message) {
    const el = this.byId('extractionStatus');
    if (el) el.textContent = message;
  }

  // ── Modals & Dialogs ──────────────────────────────────────────────────────
  /**
   * @param {string} id
   */
  closeModal(id) {
    const modal = this.byId(id);
    if (modal) modal.style.display = 'none';
  }

  /**
   * @param {string} title
   * @param {string} message
   * @returns {Promise<boolean>}
   */
  confirm(title, message) {
    return new Promise(resolve => {
      const titleEl = this.byId('confirmTitle');
      const msgEl = this.byId('confirmMessage');
      const modal = this.byId('confirmModal');
      if (titleEl) titleEl.textContent = title;
      if (msgEl) msgEl.textContent = message;
      if (modal) modal.style.display = 'flex';
      this._confirmResolve = resolve;
    });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  /**
   * @param {string} message
   * @param {string} [type]
   */
  showToast(message, type = '') {
    const toast = this.byId('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    if (this._toastTimer !== null) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  generateId() {
    return `lead_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * @param {StoredLead} lead
   * @returns {StoredLead}
   */
  normalizeStoredLead(lead) {
    return { ...lead, contacted: Boolean(lead.contacted), contactedAt: lead.contactedAt || null };
  }

  /**
   * @param {Record<string, any>} [raw]
   */
  sanitizeLeadForStorage(raw = {}) {
    return {
      name: String(raw.name || '').trim(),
      phone: String(raw.phone || '').trim(),
      email: String(raw.email || '').trim(),
      company: String(raw.company || '').trim(),
      category: String(raw.category || '').trim(),
      rating: String(raw.rating || '').trim(),
      reviews: String(raw.reviews || '').trim(),
      website: String(raw.website || '').trim(),
      address: String(raw.address || '').trim(),
      jobTitle: String(raw.jobTitle || '').trim(),
      source: String(raw.source || '').trim()
    };
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  normalizeCountryCode(value) {
    const digits = this.getCountryCodeDigits(value);
    return digits ? `+${digits}` : '';
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  getCountryCodeDigits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  /**
   * @param {unknown} value
   * @returns {number}
   */
  getRatingValue(value) {
    const parsed = parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * @param {unknown} value
   * @returns {number}
   */
  getReviewsValue(value) {
    const parsed = parseInt(String(value || '').replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** @returns {Promise<chrome.tabs.Tab | null>} */
  async getExtractionTab() {
    const activeTabs = await chrome.tabs.query({ active: true });
    return activeTabs.find(tab => tab.id && tab.url && !tab.url.startsWith('chrome-extension://')) || null;
  }

  /**
   * @param {unknown} str
   * @returns {string}
   */
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  whatsappIconSvg() {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.app = new LeadExtractor();
});
