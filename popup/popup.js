// Map Leadify – Popup Script (v2)
// Manages UI, state sync with background, WhatsApp templates, lead CRUD

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_COUNTRY_CODE = '+91';
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
    this.leads = [];
    this.extractedLeads = [];
    this.savedLeads = [];
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
    this.activeSessionId = null;
    this.currentTabId = null;
    this.currentSessionSaved = 0;
    this.extractionStartTime = null;
    this.elapsedTimer = null;

    // Settings
    this.extractionSettings = null;

    // Templates
    this.templates = [];
    this.defaultTemplateId = null;
    this.editingTemplateId = null;

    // Licensing & access monitoring state
    this.accessState = null;
    this._isUnlocked = false;
    this._licenseEventsBound = false;
    this._eventsBound = false;
    this._runtimeListenersBound = false;
    this._accessPollTimer = null;
    this._accessExpiryTimer = null;

    // Confirm dialog promise resolver
    this._confirmResolve = null;

    this.init();
  }

  getPricingUrl() {
    if (typeof ENV !== 'undefined' && ENV.APP_URL) {
      return `${ENV.APP_URL.replace(/\/$/, '')}/#pricing`;
    }
    return '#pricing';
  }

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

      document.getElementById('licenseOverlay').style.display = 'none';
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

  switchLicenseMode(mode) {
    const paidTab = document.getElementById('modePaidTab');
    const trialTab = document.getElementById('modeTrialTab');
    const paidSec = document.getElementById('paidKeySection');
    const trialSec = document.getElementById('trialKeySection');
    const err = document.getElementById('licenseError');
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
    const buyLink = document.getElementById('buySubscriptionLink');
    const buyCta = document.getElementById('buyAccessCta');
    if (buyLink) buyLink.href = pricingUrl;
    if (buyCta) buyCta.href = pricingUrl;

    document.getElementById('modePaidTab')?.addEventListener('click', () => this.switchLicenseMode('paid'));
    document.getElementById('modeTrialTab')?.addEventListener('click', () => this.switchLicenseMode('trial'));

    const submitLicense = async () => {
      const btn = document.getElementById('activateLicenseBtn');
      const input = document.getElementById('licenseKeyInput');
      const err = document.getElementById('licenseError');
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
          document.getElementById('licenseOverlay').style.display = 'none';
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
      const btn = document.getElementById('activateTrialBtn');
      const keyInput = document.getElementById('trialKeyInput');
      const emailInput = document.getElementById('trialEmailInput');
      const err = document.getElementById('licenseError');
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
        const result = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ action: 'activateTrial', trialKey, email }, res => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(res);
          });
        });

        if (result?.valid) {
          keyInput.value = '';
          emailInput.value = '';
          document.getElementById('licenseOverlay').style.display = 'none';
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

    document.getElementById('activateLicenseBtn')?.addEventListener('click', submitLicense);
    document.getElementById('licenseKeyInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitLicense(); }
    });

    document.getElementById('activateTrialBtn')?.addEventListener('click', submitTrial);
    document.getElementById('trialKeyInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitTrial(); }
    });
    document.getElementById('trialEmailInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitTrial(); }
    });

    document.getElementById('refreshAccessBtn')?.addEventListener('click', async () => {
      const refreshBtn = document.getElementById('refreshAccessBtn');
      const err = document.getElementById('licenseError');
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Checking Server...';
      try {
        const res = await this.verifyLicenseWithServer();
        if (res?.valid) {
          document.getElementById('licenseOverlay').style.display = 'none';
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

  showLicenseOverlay(accessInfo = {}) {
    this._isUnlocked = false;
    this.stopLiveAccessMonitor();

    const info = typeof accessInfo === 'boolean'
      ? { expired: accessInfo, status: accessInfo ? 'expired' : 'unauthenticated' }
      : (accessInfo || {});

    const overlay = document.getElementById('licenseOverlay');
    const banner = document.getElementById('licenseStatusBanner');
    const badge = document.getElementById('licenseStatusBadge');
    const bannerMsg = document.getElementById('licenseStatusMessage');
    const expiredActions = document.getElementById('expiredActions');
    const buyCta = document.getElementById('buyAccessCta');
    const err = document.getElementById('licenseError');
    const title = document.getElementById('licenseTitle');
    const desc = document.getElementById('licenseDesc');
    const link = document.getElementById('buySubscriptionLink');
    const sidebarBar = document.getElementById('accessStatusBar');

    if (sidebarBar) sidebarBar.style.display = 'none';
    const pricingUrl = this.getPricingUrl();
    if (link) link.href = pricingUrl;
    if (buyCta) buyCta.href = pricingUrl;

    overlay.style.display = 'flex';
    banner.classList.remove('revoked');

    const isExpired = info.status === 'expired' || Boolean(info.expired);
    const isRevoked = info.status === 'revoked' || Boolean(info.revoked);
    const isNetworkError = info.status === 'network_error' || Boolean(info.networkError);
    const isTrial = info.accessType === 'trial' || info.code === 'TRIAL_EXPIRED' || info.statusCode === 'TRIAL_EXPIRED';

    if (isExpired) {
      banner.style.display = 'block';
      expiredActions.style.display = 'flex';
      badge.textContent = isTrial ? 'TRIAL EXPIRED' : 'SUBSCRIPTION EXPIRED';
      title.textContent = isTrial ? 'Your Trial Has Expired' : 'Subscription Expired';
      desc.textContent = isTrial
        ? 'Your one-time trial has ended and cannot be reactivated. Purchase full access to continue extracting and exporting leads.'
        : 'Your approved subscription period has ended. Submit a renewal payment to restore full access.';
      const endedStr = info.expiresAt ? ` Ended: ${new Date(info.expiresAt).toLocaleString()}.` : '';
      bannerMsg.textContent = (info.error || (isTrial ? 'Trial period expired.' : 'Subscription expired.')) + endedStr;
      if (buyCta) {
        buyCta.style.display = 'flex';
        buyCta.textContent = isTrial ? 'Purchase Full Access' : 'Renew Subscription';
      }
      if (link) link.textContent = 'Need help or want to check payment status? Open Dashboard';
      err.textContent = '';
      err.style.display = 'none';
      this.switchLicenseMode('paid');
    } else if (isRevoked) {
      banner.style.display = 'block';
      banner.classList.add('revoked');
      expiredActions.style.display = 'flex';
      badge.textContent = 'ACCESS REVOKED';
      title.textContent = 'Access Revoked';
      desc.textContent = 'This license key or subscription has been revoked by the administrator.';
      bannerMsg.textContent = info.error || 'Access revoked.';
      if (buyCta) {
        buyCta.style.display = 'flex';
        buyCta.textContent = 'Purchase Full Access';
      }
      err.textContent = '';
      err.style.display = 'none';
      this.switchLicenseMode('paid');
    } else if (isNetworkError) {
      banner.style.display = 'block';
      expiredActions.style.display = 'flex';
      badge.textContent = 'SERVER VERIFICATION REQUIRED';
      title.textContent = 'Verification Unavailable';
      desc.textContent = 'Could not reach the backend server to verify your active access status.';
      bannerMsg.textContent = info.error || 'Please verify your internet connection and retry.';
      if (buyCta) buyCta.style.display = 'none';
      err.textContent = '';
      err.style.display = 'none';
    } else {
      banner.style.display = 'none';
      expiredActions.style.display = 'none';
      title.textContent = 'Activate Access';
      desc.textContent = 'Enter your paid license key or one-time trial key to unlock Map Leadify.';
      if (link) link.textContent = 'Don\'t have a key? Purchase Full Access';
      if (info.error && info.status !== 'unauthenticated') {
        err.textContent = info.error;
        err.style.display = 'block';
      } else {
        err.textContent = '';
        err.style.display = 'none';
      }
      if (info.status === 'trial_not_activated') {
        this.switchLicenseMode('trial');
      }
    }
  }

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

  renderAccessStatus(accessInfo) {
    const bar = document.getElementById('accessStatusBar');
    const badge = document.getElementById('accessTypeBadge');
    const remainingEl = document.getElementById('accessRemainingText');
    const upgradeLink = document.getElementById('upgradeToProLink');
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
    if (this._accessPollTimer) {
      clearInterval(this._accessPollTimer);
      this._accessPollTimer = null;
    }
    if (this._accessExpiryTimer) {
      clearTimeout(this._accessExpiryTimer);
      this._accessExpiryTimer = null;
    }
  }

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
    const saved = await Storage.get('extractionSettings');
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
    const limitInput = document.getElementById('maxLeadsInput');
    const noLimitInput = document.getElementById('noLimitInput');
    const countryCodeInput = document.getElementById('countryCodeInput');
    const parsedLimit = parseInt(limitInput.value, 10);
    const ccDigits = this.getCountryCodeDigits(countryCodeInput.value);
    const countryCode = this.normalizeCountryCode(ccDigits || DEFAULT_COUNTRY_CODE);
    countryCodeInput.value = this.getCountryCodeDigits(countryCode);

    this.extractionSettings = {
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100,
      noLimit: noLimitInput.checked,
      requirePhone: document.getElementById('requirePhoneInput').checked,
      requireWebsite: document.getElementById('requireWebsiteInput').checked,
      requireEmail: document.getElementById('requireEmailInput').checked,
      countryCode
    };

    await Storage.set('extractionSettings', this.extractionSettings);
  }

  renderSettings() {
    const s = this.extractionSettings;
    document.getElementById('maxLeadsInput').value = s.limit;
    document.getElementById('noLimitInput').checked = s.noLimit;
    document.getElementById('requirePhoneInput').checked = s.requirePhone;
    document.getElementById('requireWebsiteInput').checked = s.requireWebsite;
    document.getElementById('requireEmailInput').checked = s.requireEmail;
    document.getElementById('countryCodeInput').value = this.getCountryCodeDigits(s.countryCode);
    document.getElementById('maxLeadsInput').disabled = s.noLimit;
    const phoneNote = document.getElementById('phoneNote');
    if (phoneNote) {
      phoneNote.textContent = 'Tip: Disable "Phone Only" for Google Maps – most listings don\'t show phones.';
    }
  }

  renderVersion() {
    const badge = document.getElementById('versionBadge');
    if (badge) badge.textContent = `v${chrome.runtime.getManifest().version}`;
  }

  // ── Storage / Leads ───────────────────────────────────────────────────────
  async loadLeads() {
    const stored = await Storage.getAllLeads();
    this.leads = stored.map(l => this.normalizeStoredLead(l));
    this.extractedLeads = this.leads.filter(l => !l.type || l.type === 'extracted');
    this.savedLeads = this.leads.filter(l => l.type === 'saved');
    this.applyFilters();
    this.updateBadges();
  }

  // ── Templates ─────────────────────────────────────────────────────────────
  async loadTemplates() {
    this.templates = await Storage.getTemplates();
    this.defaultTemplateId = await Storage.getDefaultTemplateId();

    // Seed default template on first install
    if (this.templates.length === 0) {
      await Storage.addTemplate(DEFAULT_TEMPLATE);
      this.templates = [DEFAULT_TEMPLATE];
      this.defaultTemplateId = DEFAULT_TEMPLATE.id;
    }

    // Set textarea to current default template
    this.loadTemplateIntoTextarea(this.defaultTemplateId);
    this.renderTemplates();
    this.renderQuickSelect();
  }

  getSelectedTemplate() {
    const id = this.defaultTemplateId;
    const tpl = this.templates.find(t => t.id === id) || this.templates[0] || DEFAULT_TEMPLATE;
    // Use the live textarea content as the message body (user may have edited it)
    const textarea = document.getElementById('whatsAppMessageInput');
    if (textarea) {
      return { ...tpl, body: textarea.value.trim() || tpl.body };
    }
    return tpl;
  }

  loadTemplateIntoTextarea(templateId) {
    const tpl = this.templates.find(t => t.id === templateId) || this.templates[0];
    const textarea = document.getElementById('whatsAppMessageInput');
    if (textarea && tpl) textarea.value = tpl.body;
  }

  renderQuickSelect() {
    const sel = document.getElementById('templateQuickSelect');
    if (!sel) return;
    sel.innerHTML = this.templates.map(t =>
      `<option value="${t.id}" ${t.id === this.defaultTemplateId ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`
    ).join('');
  }

  renderTemplates() {
    const list = document.getElementById('templatesList');
    const empty = document.getElementById('templatesEmpty');
    if (!list) return;

    if (this.templates.length === 0) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }

    empty?.classList.add('hidden');
    list.innerHTML = this.templates.map(t => `
      <div class="template-item ${t.id === this.defaultTemplateId ? 'is-default' : ''}" data-id="${t.id}">
        <div class="template-item-info">
          <span class="template-item-name">${this.escapeHtml(t.name)}</span>
          ${t.id === this.defaultTemplateId ? '<span class="default-badge">Default</span>' : ''}
        </div>
        <div class="template-item-actions">
          ${t.id !== this.defaultTemplateId ? `<button class="tpl-btn set-default" data-id="${t.id}" title="Set as default">★</button>` : ''}
          <button class="tpl-btn edit" data-id="${t.id}" title="Edit">✏️</button>
          <button class="tpl-btn delete" data-id="${t.id}" title="Delete">🗑️</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('button.set-default').forEach(btn => {
      btn.addEventListener('click', () => this.setDefaultTemplate(btn.dataset.id));
    });
    list.querySelectorAll('button.edit').forEach(btn => {
      btn.addEventListener('click', () => this.openTemplateEditor(btn.dataset.id));
    });
    list.querySelectorAll('button.delete').forEach(btn => {
      btn.addEventListener('click', () => this.deleteTemplate(btn.dataset.id));
    });
  }

  openTemplateEditor(id = null) {
    const editor = document.getElementById('templateEditor');
    const title = document.getElementById('editorTitle');
    const nameInput = document.getElementById('templateNameInput');
    const bodyInput = document.getElementById('templateBodyInput');

    this.editingTemplateId = id;

    if (id) {
      const tpl = this.templates.find(t => t.id === id);
      if (!tpl) return;
      title.textContent = 'Edit Template';
      nameInput.value = tpl.name;
      bodyInput.value = tpl.body;
    } else {
      title.textContent = 'New Template';
      nameInput.value = '';
      bodyInput.value = '';
    }

    editor.classList.remove('hidden');
    nameInput.focus();
  }

  closeTemplateEditor() {
    document.getElementById('templateEditor')?.classList.add('hidden');
    this.editingTemplateId = null;
  }

  async saveTemplate() {
    const name = document.getElementById('templateNameInput').value.trim();
    const body = document.getElementById('templateBodyInput').value.trim();

    if (!name) { this.showToast('Template name is required', 'error'); return; }
    if (!body) { this.showToast('Template message is required', 'error'); return; }

    if (this.editingTemplateId) {
      const updated = {
        ...this.templates.find(t => t.id === this.editingTemplateId),
        name,
        body,
        updatedAt: Date.now()
      };
      await Storage.updateTemplate(updated);
      this.showToast('Template updated', 'success');
    } else {
      const newTpl = { id: `tpl_${Date.now()}`, name, body, createdAt: Date.now() };
      await Storage.addTemplate(newTpl);
      this.showToast('Template created', 'success');
    }

    await this.loadTemplates();
    this.closeTemplateEditor();
  }

  // Called when user edits the in-sidebar WhatsApp textarea
  async onWhatsAppMessageChange() {
    const textarea = document.getElementById('whatsAppMessageInput');
    if (!textarea) return;
    const body = textarea.value.trim();
    if (!body) return;
    // Update the active template body in storage
    const activeTpl = this.templates.find(t => t.id === this.defaultTemplateId);
    if (activeTpl) {
      const updated = { ...activeTpl, body, updatedAt: Date.now() };
      await Storage.updateTemplate(updated);
      this.templates = this.templates.map(t => t.id === activeTpl.id ? updated : t);
    }
  }

  async setDefaultTemplate(id) {
    this.defaultTemplateId = id;
    await Storage.setDefaultTemplateId(id);
    this.loadTemplateIntoTextarea(id);
    this.renderTemplates();
    this.renderQuickSelect();
    this.showToast('Default template updated', 'success');
  }

  async deleteTemplate(id) {
    if (this.templates.length === 1) {
      this.showToast('Cannot delete the only template', 'error');
      return;
    }

    const confirmed = await this.confirm('Delete Template', 'Are you sure you want to delete this template?');
    if (!confirmed) return;

    await Storage.deleteTemplate(id);
    await this.loadTemplates();
    this.showToast('Template deleted', 'success');
  }

  insertVar(variable) {
    // Insert into whichever textarea is focused, else the main one
    const focused = document.activeElement;
    const ta = (focused && focused.tagName === 'TEXTAREA') ? focused : document.getElementById('whatsAppMessageInput');
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = ta.value.substring(0, start);
    const after = ta.value.substring(end);
    ta.value = before + variable + after;
    ta.selectionStart = ta.selectionEnd = start + variable.length;
    ta.focus();
  }

  // ── Background State Sync ─────────────────────────────────────────────────
  async syncExtractionState() {
    try {
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
      console.warn('[Popup] Could not fetch session state from background:', err.message);
    }
  }

  applySessionState(session) {
    this.isExtracting = session.isExtracting;
    this.activeSessionId = session.sessionId;
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

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  handleSessionUpdate(session) {
    if (!session) return;
    if (session.licenseRevoked) {
      this.handleAccessLost(session.licenseState || { status: 'expired', expired: true });
      return;
    }

    this.isExtracting = session.isExtracting;
    this.activeSessionId = session.sessionId;

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
        await Storage.addLead(preparedLead);
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
    document.getElementById('sidebarRefreshAccessBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('sidebarRefreshAccessBtn');
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

    document.getElementById('logoutLicenseBtn')?.addEventListener('click', async () => {
      const confirmed = await this.confirm('Switch Key / Sign Out', 'Remove the saved license or trial key from this browser?');
      if (!confirmed) return;
      await new Promise(resolve => chrome.runtime.sendMessage({ action: 'logoutLicense' }, resolve));
      this.accessState = null;
      this.handleAccessLost({ status: 'unauthenticated' });
    });

    // Sidebar nav
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchSidebarPanel(btn.dataset.panel, btn));
    });

    // Extraction buttons
    document.getElementById('startExtraction').addEventListener('click', () => this.startExtraction());
    document.getElementById('stopExtraction').addEventListener('click', () => this.stopExtraction());
    document.getElementById('saveAllLeads').addEventListener('click', () => this.saveAllExtractedLeads());
    document.getElementById('refreshLeads').addEventListener('click', () => this.refreshData());

    // Settings
    document.getElementById('maxLeadsInput').addEventListener('change', () => this.saveSettings());
    document.getElementById('noLimitInput').addEventListener('change', () => {
      document.getElementById('maxLeadsInput').disabled = document.getElementById('noLimitInput').checked;
      this.saveSettings();
    });
    document.getElementById('requirePhoneInput').addEventListener('change', () => this.saveSettings());
    document.getElementById('requireWebsiteInput').addEventListener('change', () => this.saveSettings());
    document.getElementById('requireEmailInput').addEventListener('change', () => this.saveSettings());
    document.getElementById('countryCodeInput').addEventListener('blur', () => this.saveSettings());

    // WhatsApp message textarea (in-sidebar)
    const waTextarea = document.getElementById('whatsAppMessageInput');
    if (waTextarea) {
      waTextarea.addEventListener('change', () => this.onWhatsAppMessageChange());
      waTextarea.addEventListener('blur', () => this.onWhatsAppMessageChange());
    }

    // Quick template selector dropdown
    const quickSel = document.getElementById('templateQuickSelect');
    if (quickSel) {
      quickSel.addEventListener('change', async (e) => {
        this.defaultTemplateId = e.target.value;
        await Storage.setDefaultTemplateId(e.target.value);
        this.loadTemplateIntoTextarea(e.target.value);
        this.renderTemplates();
        this.showToast('Template switched', 'success');
      });
    }

    // Gear button → open templates panel
    document.getElementById('openTemplatesPanel')?.addEventListener('click', () => {
      const btn = document.getElementById('navTemplates');
      this.switchSidebarPanel('templatesPanel', btn);
    });

    // Inline var chips (in extraction panel)
    document.querySelectorAll('.var-chips-inline .var-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const ta = document.getElementById('whatsAppMessageInput');
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = ta.value.substring(0, start) + chip.dataset.var + ta.value.substring(end);
        ta.selectionStart = ta.selectionEnd = start + chip.dataset.var.length;
        ta.focus();
      });
    });

    // Tabs
    document.getElementById('tabExtracted').addEventListener('click', () => this.handleTabClick('extracted'));
    document.getElementById('tabSaved').addEventListener('click', () => this.handleTabClick('saved'));

    // Search (extracted)
    document.getElementById('searchInput').addEventListener('input', e => {
      this.searchQuery = e.target.value;
      document.getElementById('clearSearch').classList.toggle('hidden', !e.target.value);
      this.applyFilters();
    });
    document.getElementById('clearSearch').addEventListener('click', () => {
      document.getElementById('searchInput').value = '';
      this.searchQuery = '';
      document.getElementById('clearSearch').classList.add('hidden');
      this.applyFilters();
    });

    // Search (saved)
    document.getElementById('savedSearchInput').addEventListener('input', e => {
      this.savedSearchQuery = e.target.value;
      document.getElementById('clearSavedSearch').classList.toggle('hidden', !e.target.value);
      this.renderSavedLeads();
    });
    document.getElementById('clearSavedSearch').addEventListener('click', () => {
      document.getElementById('savedSearchInput').value = '';
      this.savedSearchQuery = '';
      document.getElementById('clearSavedSearch').classList.add('hidden');
      this.renderSavedLeads();
    });

    // Filter
    document.getElementById('filterSelect').addEventListener('change', e => {
      this.typeFilter = e.target.value;
      this.applyFilters();
    });

    // Scroll-based pagination
    document.getElementById('leadsList').addEventListener('scroll', () => this.handleLeadListScroll());

    // Lead actions (event delegation)
    document.getElementById('leadsList').addEventListener('click', e => this.handleLeadActionClick(e));
    document.getElementById('savedList').addEventListener('click', e => this.handleSavedLeadClick(e));

    // Export & Clear
    document.getElementById('exportCSV').addEventListener('click', () => this.exportCSV());
    document.getElementById('exportExcel').addEventListener('click', () => this.exportExcel());
    document.getElementById('clearAll').addEventListener('click', () => this.clearAll());

    // Modals
    document.getElementById('closeModal').addEventListener('click', () => this.closeModal('addLeadModal'));
    document.getElementById('addLeadForm').addEventListener('submit', e => this.handleAddLead(e));
    document.getElementById('closeEditModal').addEventListener('click', () => this.closeModal('editLeadModal'));
    document.getElementById('editLeadForm').addEventListener('submit', e => this.handleEditLead(e));
    document.getElementById('closeSavedLeadViewModal').addEventListener('click', () => this.closeModal('savedLeadViewModal'));

    // Confirm dialog
    document.getElementById('confirmOk').addEventListener('click', () => {
      if (this._confirmResolve) { this._confirmResolve(true); this._confirmResolve = null; }
      this.closeModal('confirmModal');
    });
    document.getElementById('confirmCancel').addEventListener('click', () => {
      if (this._confirmResolve) { this._confirmResolve(false); this._confirmResolve = null; }
      this.closeModal('confirmModal');
    });

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          overlay.style.display = 'none';
          if (this._confirmResolve) { this._confirmResolve(false); this._confirmResolve = null; }
        }
      });
    });

    // Templates panel
    document.getElementById('addTemplateBtn').addEventListener('click', () => this.openTemplateEditor(null));
    document.getElementById('saveTemplateBtn').addEventListener('click', () => this.saveTemplate());
    document.getElementById('cancelTemplateBtn').addEventListener('click', () => this.closeTemplateEditor());

    // Variable chips
    document.querySelectorAll('.var-chip').forEach(chip => {
      chip.addEventListener('click', () => this.insertVar(chip.dataset.var));
    });
  }

  // ── Sidebar Nav ───────────────────────────────────────────────────────────
  switchSidebarPanel(panelId, btn) {
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(panelId)?.classList.add('active');
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
      if (!this.extractionSettings.countryCode) throw new Error('Please enter a valid country code (e.g. 91)');

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
          if (retries === 0 || !(err.message || '').includes('Receiving end does not exist')) {
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
      let msg = error.message || 'Extraction failed';
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
    const startBtn = document.getElementById('startExtraction');
    const stopBtn = document.getElementById('stopExtraction');
    const spinner = document.getElementById('extractionSpinner');
    const icon = document.querySelector('.btn-icon-start');
    const text = document.getElementById('startExtractionText');

    if (this.isExtracting) {
      startBtn.disabled = true;
      startBtn.classList.add('is-extracting');
      spinner.style.display = 'block';
      if (icon) icon.style.display = 'none';
      if (text) text.textContent = 'Running…';
      stopBtn?.classList.remove('hidden');
    } else {
      startBtn.disabled = false;
      startBtn.classList.remove('is-extracting');
      spinner.style.display = 'none';
      if (icon) icon.style.display = '';
      if (text) text.textContent = 'Start Discovery';
      stopBtn?.classList.add('hidden');
    }

    // Status indicator
    const indicator = document.getElementById('statusIndicator');
    if (indicator) {
      indicator.className = 'status-indicator';
      if (this.isExtracting) indicator.classList.add('running');
    }
  }

  // ── Lead Ingestion ────────────────────────────────────────────────────────
  async ingestLeads(rawLeads = []) {
    let saved = 0;
    for (const rawLead of rawLeads) {
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
        await Storage.addLead(preparedLead);
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

    await Storage.clearAllLeads();
    for (const lead of this.leads) await Storage.addLead(lead);

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
        await Storage.clearAllLeads();
        for (const lead of this.leads) {
          // Use updateLead (which uses put) instead of addLead to avoid ConstraintErrors
          await Storage.updateLead(lead);
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
    const btn = document.getElementById('refreshLeads');
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
  handleTabClick(tabId) {
    this.activeTab = tabId;
    document.getElementById('tabExtracted').classList.toggle('active', tabId === 'extracted');
    document.getElementById('tabSaved').classList.toggle('active', tabId === 'saved');
    document.getElementById('extractedLeadsContainer').classList.toggle('active', tabId === 'extracted');
    document.getElementById('savedLeadsContainer').classList.toggle('active', tabId === 'saved');
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

  renderLeads(reset = false) {
    const container = document.getElementById('leadsList');
    const listStatus = document.getElementById('listStatus');

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

  renderLeadRow(lead) {
    const hasWA = this.hasWhatsAppNumber(lead);
    const ratingHtml = lead.rating ? `<span class="lead-rating">⭐ ${lead.rating}${lead.reviews ? ` (${lead.reviews})` : ''}</span>` : '';
    const categoryHtml = lead.category ? `<span class="lead-category">${this.escapeHtml(lead.category.slice(0, 30))}</span>` : '';

    return `
      <div class="lead-row ${lead.contacted ? 'contacted' : ''}" data-id="${lead.id}">
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
          <button type="button" class="lead-action-btn whatsapp ${hasWA ? '' : 'disabled'}" title="${hasWA ? 'Send WhatsApp' : 'No phone number'}" data-action="whatsapp" data-id="${lead.id}" ${hasWA ? '' : 'disabled'}>
            ${this.whatsappIconSvg()}
          </button>
          <button type="button" class="lead-action-btn contact ${lead.contacted ? 'active' : ''}" title="${lead.contacted ? 'Mark as not contacted' : 'Mark as contacted'}" data-action="contact" data-id="${lead.id}">
            ${lead.contacted ? '✓' : '○'}
          </button>
          <button type="button" class="lead-action-btn edit" title="Edit" data-action="edit" data-id="${lead.id}">✏️</button>
          <button type="button" class="lead-action-btn delete" title="Delete" data-action="delete" data-id="${lead.id}">🗑️</button>
        </div>
      </div>
    `;
  }

  renderSavedLeads() {
    const container = document.getElementById('savedList');
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

    container.innerHTML = filtered.map(lead => `
      <div class="saved-lead-row" data-id="${lead.id}">
        <div class="saved-lead-info">
          <div class="saved-lead-name">${this.escapeHtml(lead.name || 'Unknown')}</div>
          <div class="saved-lead-sub">
            ${lead.phone ? `<span>📞 ${this.escapeHtml(lead.phone)}</span>` : ''}
            ${lead.company ? `<span>🏢 ${this.escapeHtml(lead.company)}</span>` : ''}
          </div>
        </div>
        <div class="saved-lead-actions">
          <button type="button" class="lead-action-btn whatsapp ${this.hasWhatsAppNumber(lead) ? '' : 'disabled'}" title="${this.hasWhatsAppNumber(lead) ? 'Send WhatsApp' : 'No phone number'}" data-action="whatsapp" data-id="${lead.id}" ${this.hasWhatsAppNumber(lead) ? '' : 'disabled'}>
            ${this.whatsappIconSvg()}
          </button>
          <button class="lead-action-btn contact ${lead.contacted ? 'active' : ''}" data-action="contact" data-id="${lead.id}" title="Toggle contacted">
            ${lead.contacted ? '✓' : '○'}
          </button>
          <button class="lead-action-btn edit" data-action="edit-saved" data-id="${lead.id}" title="Edit">✏️</button>
          <button class="lead-action-btn delete" data-action="delete" data-id="${lead.id}" title="Delete">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  handleLeadListScroll() {
    const container = document.getElementById('leadsList');
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining <= 60) this.renderLeads();
  }

  handleLeadActionClick(event) {
    const btn = event.target.closest('button[data-action][data-id]');
    if (!btn || btn.disabled) return;
    this.dispatchLeadAction(btn.dataset.action, btn.dataset.id);
  }

  handleSavedLeadClick(event) {
    const btn = event.target.closest('button[data-action][data-id]');
    if (btn && !btn.disabled) {
      this.dispatchLeadAction(btn.dataset.action, btn.dataset.id);
      return;
    }
    // Click on row → open detail
    const row = event.target.closest('.saved-lead-row[data-id]');
    if (row) this.showSavedLeadDetails(row.dataset.id);
  }

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
    const listStatus = document.getElementById('listStatus');
    if (!this.filteredLeads.length) { listStatus.textContent = ''; return; }
    const hasMore = this.renderedLeadCount < this.filteredLeads.length;
    listStatus.textContent = hasMore
      ? `Showing ${this.renderedLeadCount} of ${this.filteredLeads.length} leads`
      : `All ${this.filteredLeads.length} leads shown`;
  }

  updateBadges() {
    document.getElementById('extractedBadge').textContent = this.extractedLeads.length;
    document.getElementById('savedBadge').textContent = this.savedLeads.length;
  }

  // ── Live Stats ─────────────────────────────────────────────────────────────
  updateLiveStats({ totalFound, totalSaved, totalFailed }) {
    document.getElementById('statFound').textContent = totalFound ?? 0;
    document.getElementById('statSaved').textContent = totalSaved ?? 0;
    document.getElementById('statFailed').textContent = totalFailed ?? 0;
  }

  showLiveStats(show) {
    const grid = document.getElementById('liveStatsGrid');
    if (grid) grid.style.display = show ? 'grid' : 'none';
  }

  startElapsedTimer(startTime) {
    this.stopElapsedTimer();
    const update = () => {
      const elapsed = Math.floor((Date.now() - (startTime || Date.now())) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      document.getElementById('statElapsed').textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
    };
    update();
    this.elapsedTimer = setInterval(update, 1000);
  }

  stopElapsedTimer() {
    if (this.elapsedTimer) { clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
  }

  showErrorLog(errors) {
    const log = document.getElementById('errorLog');
    const list = document.getElementById('errorLogList');
    if (!log || !list) return;
    if (errors.length === 0) { log.classList.add('hidden'); return; }
    log.classList.remove('hidden');
    list.innerHTML = errors.slice(-5).map(e => `<li>${this.escapeHtml(String(e))}</li>`).join('');
  }

  // ── Lead Detail (Saved) ───────────────────────────────────────────────────
  showSavedLeadDetails(id) {
    const lead = this.leads.find(l => l.id === id);
    if (!lead) return;

    const content = document.getElementById('savedLeadViewContent');
    content.innerHTML = `
      <div class="lead-detail-view">
        <div class="detail-name">${this.escapeHtml(lead.name || 'Unknown')}</div>
        <div class="detail-fields">
          ${lead.phone ? `<div class="detail-field"><span class="detail-label">📞 Phone</span><span class="detail-val">${this.escapeHtml(lead.phone)}</span></div>` : ''}
          ${lead.email ? `<div class="detail-field"><span class="detail-label">✉️ Email</span><span class="detail-val">${this.escapeHtml(lead.email)}</span></div>` : ''}
          ${lead.company ? `<div class="detail-field"><span class="detail-label">🏢 Company</span><span class="detail-val">${this.escapeHtml(lead.company)}</span></div>` : ''}
          ${lead.website ? `<div class="detail-field"><span class="detail-label">🌐 Website</span><a href="${this.escapeHtml(lead.website)}" target="_blank" class="detail-link">${this.escapeHtml(lead.website)}</a></div>` : ''}
          ${lead.address ? `<div class="detail-field"><span class="detail-label">📍 Address</span><span class="detail-val">${this.escapeHtml(lead.address)}</span></div>` : ''}
          ${lead.category ? `<div class="detail-field"><span class="detail-label">🏷 Category</span><span class="detail-val">${this.escapeHtml(lead.category)}</span></div>` : ''}
          ${lead.rating ? `<div class="detail-field"><span class="detail-label">⭐ Rating</span><span class="detail-val">${this.escapeHtml(lead.rating)} (${this.escapeHtml(String(lead.reviews || 0))} reviews)</span></div>` : ''}
          <div class="detail-field">
            <span class="detail-label">Status</span>
            <span class="status-badge ${lead.contacted ? 'contacted' : ''}">
              ${lead.contacted ? `✓ Contacted on ${new Date(lead.contactedAt).toLocaleDateString()}` : '○ Not Contacted'}
            </span>
          </div>
        </div>
        <div class="detail-actions">
          ${this.hasWhatsAppNumber(lead) ? `<button class="lead-action-btn whatsapp" data-action="whatsapp" data-id="${lead.id}" title="Send WhatsApp">${this.whatsappIconSvg()} WhatsApp</button>` : ''}
          <button class="lead-action-btn contact ${lead.contacted ? 'active' : ''}" data-action="contact" data-id="${lead.id}">${lead.contacted ? '✓ Contacted' : '○ Mark Contacted'}</button>
          <button class="lead-action-btn edit" data-action="edit-saved" data-id="${lead.id}">✏️ Edit</button>
          <button class="lead-action-btn delete" data-action="delete" data-id="${lead.id}">🗑️ Delete</button>
        </div>
      </div>
    `;

    content.querySelector('.detail-actions')?.addEventListener('click', e => {
      const btn = e.target.closest('button[data-action][data-id]');
      if (!btn) return;
      this.dispatchLeadAction(btn.dataset.action, btn.dataset.id);
      if (btn.dataset.action === 'delete') this.closeModal('savedLeadViewModal');
      else if (btn.dataset.action === 'contact') {
        this.closeModal('savedLeadViewModal');
        setTimeout(() => this.showSavedLeadDetails(btn.dataset.id), 300);
      }
    });

    document.getElementById('savedLeadViewModal').style.display = 'flex';
  }

  // ── Lead CRUD ─────────────────────────────────────────────────────────────
  async deleteLead(id) {
    const confirmed = await this.confirm('Delete Lead', 'Delete this lead permanently?');
    if (!confirmed) return;
    await Storage.deleteLead(id);
    await this.loadLeads();
    this.renderAll();
    this.showToast('Lead deleted', 'success');
  }

  editLead(id) {
    const lead = this.leads.find(l => l.id === id);
    if (!lead) return;

    const form = document.getElementById('editLeadForm');
    form.id.value = lead.id;
    form.name.value = lead.name || '';
    form.email.value = lead.email || '';
    form.phone.value = lead.phone || '';
    form.company.value = lead.company || '';
    form.jobTitle.value = lead.jobTitle || '';
    form.website.value = lead.website || '';
    form.address.value = lead.address || '';

    document.getElementById('editLeadModal').style.display = 'flex';
  }

  async handleEditLead(e) {
    e.preventDefault();
    const form = e.target;
    const id = form.id.value;
    const existing = this.leads.find(l => l.id === id);
    if (!existing) { this.showToast('Lead not found', 'error'); return; }

    const updatedLead = {
      ...existing,
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      company: form.company.value.trim(),
      jobTitle: form.jobTitle.value.trim(),
      website: form.website.value.trim(),
      address: form.address.value.trim(),
      updatedAt: Date.now()
    };

    await Storage.updateLead(updatedLead);
    await this.loadLeads();
    this.renderAll();
    this.closeModal('editLeadModal');
    this.showToast('Lead updated', 'success');
  }

  async handleAddLead(e) {
    e.preventDefault();
    const form = e.target;

    const newLead = {
      id: this.generateId(),
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      company: form.company.value.trim(),
      jobTitle: form.jobTitle.value.trim(),
      website: form.website.value.trim(),
      address: form.address.value.trim(),
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

    await Storage.addLead(newLead);
    await this.loadLeads();
    this.renderAll();
    this.closeModal('addLeadModal');
    this.showToast('Lead added', 'success');
    form.reset();
  }

  async clearAll() {
    const confirmed = await this.confirm('Clear All Leads', 'This will permanently delete ALL leads. This cannot be undone.');
    if (!confirmed) return;

    await Storage.clearAllLeads();
    this.leads = [];
    this.extractedLeads = [];
    this.savedLeads = [];
    this.filteredLeads = [];
    this.renderAll();
    this.updateBadges();
    this.showToast('All leads cleared', 'success');
  }

  // ── Toggle Contacted ──────────────────────────────────────────────────────
  async toggleContacted(id, forceValue = null) {
    const lead = this.leads.find(l => l.id === id);
    if (!lead) return;

    const newValue = forceValue !== null ? forceValue : !lead.contacted;
    const updatedLead = {
      ...lead,
      contacted: newValue,
      contactedAt: newValue ? Date.now() : null,
      updatedAt: Date.now()
    };

    await Storage.updateLead(updatedLead);
    this.leads = this.leads.map(l => l.id === id ? updatedLead : l);
    this.extractedLeads = this.leads.filter(l => !l.type || l.type === 'extracted');
    this.savedLeads = this.leads.filter(l => l.type === 'saved');
    this.applyFilters();
    this.showToast(newValue ? 'Marked as contacted' : 'Marked as not contacted', 'success');
  }

  // ── WhatsApp ──────────────────────────────────────────────────────────────
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

  buildWhatsAppUrl(lead, messageBody) {
    const phone = this.formatPhoneForWhatsApp(lead.phone);
    if (!phone || phone.length < 10) return '';

    const rawMessage = messageBody || this.getSelectedTemplate().body;
    const personalizedMessage = this.substitutePlaceholders(rawMessage, lead);
    return `https://wa.me/${phone}?text=${encodeURIComponent(personalizedMessage)}`;
  }

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

  formatPhoneForWhatsApp(phone) {
    if (!phone) return '';
    let digits = String(phone).replace(/\D/g, '');
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

  addWorksheetHyperlinks(worksheet, data, columnIndex, label) {
    data.forEach((row, rowIndex) => {
      const url = row['WhatsApp URL'];
      if (!url) return;
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex });
      worksheet[cellAddress] = { t: 's', v: label, l: { Target: url } };
    });
  }

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

  getTimestampedFilename(filename) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dotIdx = filename.lastIndexOf('.');
    return dotIdx >= 0
      ? `${filename.slice(0, dotIdx)}_${ts}${filename.slice(dotIdx)}`
      : `${filename}_${ts}`;
  }

  // ── Progress UI ───────────────────────────────────────────────────────────
  showProgress(percent) {
    document.getElementById('progressContainer').style.display = 'flex';
    document.getElementById('progressFill').style.width = `${percent}%`;
    document.getElementById('progressText').textContent = `${Math.round(percent)}%`;
  }

  hideProgress() {
    document.getElementById('progressContainer').style.display = 'none';
  }

  setExtractionStatus(message) {
    document.getElementById('extractionStatus').textContent = message;
  }

  // ── Modals & Dialogs ──────────────────────────────────────────────────────
  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
  }

  confirm(title, message) {
    return new Promise(resolve => {
      document.getElementById('confirmTitle').textContent = title;
      document.getElementById('confirmMessage').textContent = message;
      document.getElementById('confirmModal').style.display = 'flex';
      this._confirmResolve = resolve;
    });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  generateId() {
    return `lead_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  normalizeStoredLead(lead) {
    return { ...lead, contacted: Boolean(lead.contacted), contactedAt: lead.contactedAt || null };
  }

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

  normalizeCountryCode(value) {
    const digits = this.getCountryCodeDigits(value);
    return digits ? `+${digits}` : '';
  }

  getCountryCodeDigits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  getRatingValue(value) {
    const parsed = parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  getReviewsValue(value) {
    const parsed = parseInt(String(value || '').replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async getExtractionTab() {
    const activeTabs = await chrome.tabs.query({ active: true });
    return activeTabs.find(tab => tab.id && tab.url && !tab.url.startsWith('chrome-extension://')) || null;
  }

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
