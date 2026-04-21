// Lead Extractor Pro - Popup Script

class LeadExtractor {
  static DEFAULT_COUNTRY_CODE = '+91';
  static DEFAULT_WHATSAPP_MESSAGE = 'Hi, I found your business details and wanted to connect regarding your services.';

  constructor() {
    this.leads = [];
    this.filteredLeads = [];
    this.renderedLeadCount = 0;
    this.renderBatchSize = 25;
    this.isExtracting = false;
    this.activeSessionId = null;
    this.currentTabId = null;
    this.currentSessionSaved = 0;
    this.autoExportOnStop = false;
    this.searchQuery = '';
    this.typeFilter = 'all';

    this.init();
  }

  async init() {
    await this.loadLeads();
    await this.loadExtractionSettings();
    this.bindEvents();
    this.bindRuntimeListeners();
    this.renderVersion();
    this.updateCounts();
    this.renderExtractionSettings();
  }

  // Storage methods
  async loadExtractionSettings() {
    const saved = await Storage.get('extractionSettings');
    this.extractionSettings = {
      limit: saved?.limit || 100,
      noLimit: Boolean(saved?.noLimit) || true,
      requirePhone: Boolean(saved?.requirePhone) || true, // Default ON as requested
      countryCode: this.normalizeCountryCode(saved?.countryCode || LeadExtractor.DEFAULT_COUNTRY_CODE),
      whatsAppMessage: saved?.whatsAppMessage?.trim() || LeadExtractor.DEFAULT_WHATSAPP_MESSAGE
    };
  }

  async saveExtractionSettings() {
    const limitInput = document.getElementById('maxLeadsInput');
    const noLimitInput = document.getElementById('noLimitInput');
    const countryCodeInput = document.getElementById('countryCodeInput');
    const parsedLimit = parseInt(limitInput.value, 10);
    const countryCodeDigits = this.getCountryCodeDigits(countryCodeInput.value);
    const countryCode = this.normalizeCountryCode(countryCodeDigits || LeadExtractor.DEFAULT_COUNTRY_CODE);

    countryCodeInput.value = this.getCountryCodeDigits(countryCode);

    this.extractionSettings = {
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100,
      noLimit: noLimitInput.checked,
      requirePhone: document.getElementById('requirePhoneInput').checked,
      countryCode,
      whatsAppMessage: this.getWhatsAppMessage()
    };

    await Storage.set('extractionSettings', this.extractionSettings);
  }

  async loadLeads() {
    const storedLeads = await Storage.getAllLeads();
    this.leads = storedLeads.map((lead) => this.normalizeStoredLead(lead));
    this.applyLeadFilters();
  }

  // Event binding
  bindEvents() {
    // Extraction
    document.getElementById('startExtraction').addEventListener('click', () => this.startExtraction());
    document.getElementById('stopExtraction').addEventListener('click', () => this.stopExtraction());
    document.getElementById('deduplicate').addEventListener('click', () => this.deduplicate());
    document.getElementById('saveCurrentLead').addEventListener('click', () => this.requestSaveCurrentLead());
    document.getElementById('maxLeadsInput').addEventListener('change', () => this.handleLimitChange());
    document.getElementById('noLimitInput').addEventListener('change', () => this.handleNoLimitChange());
    document.getElementById('requirePhoneInput').addEventListener('change', () => this.handleRequirePhoneChange());
    document.getElementById('countryCodeInput').addEventListener('input', (e) => this.handleCountryCodeInput(e));
    document.getElementById('countryCodeInput').addEventListener('change', () => this.handleCountryCodeChange());
    document.getElementById('countryCodeInput').addEventListener('blur', () => this.handleCountryCodeChange());
    document.getElementById('whatsAppMessageInput').addEventListener('change', () => this.handleWhatsAppMessageChange());
    document.getElementById('whatsAppMessageInput').addEventListener('blur', () => this.handleWhatsAppMessageChange());

    // Search & Filter
    document.getElementById('searchInput').addEventListener('input', (e) => this.filterLeads(e.target.value));
    document.getElementById('filterSelect').addEventListener('change', (e) => this.filterByType(e.target.value));
    document.getElementById('leadsList').addEventListener('scroll', () => this.handleLeadListScroll());
    document.getElementById('leadsList').addEventListener('click', (e) => this.handleLeadActionClick(e));

    // Export
    document.getElementById('exportCSV').addEventListener('click', () => this.exportCSV());
    document.getElementById('exportExcel').addEventListener('click', () => this.exportExcel());
    document.getElementById('clearAll').addEventListener('click', () => this.clearAll());

    // Modals
    document.getElementById('closeModal').addEventListener('click', () => this.closeModal());
    document.getElementById('addLeadForm').addEventListener('submit', (e) => this.handleAddLead(e));
    document.getElementById('closeEditModal').addEventListener('click', () => this.closeEditModal());
    document.getElementById('editLeadForm').addEventListener('submit', (e) => this.handleEditLead(e));
    document.getElementById('closeWindowBtn').addEventListener('click', () => window.close());
  }

  bindRuntimeListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.action === 'extractionProgress') {
        this.handleExtractionProgress(message);
      } else if (message?.action === 'leadsCleared') {
        this.handleLeadsCleared();
      } else if (message?.action === 'saveLeadRequest') {
        this.handleSaveLeadRequest(message.lead, sendResponse);
        return true;
      }
      return false;
    });
  }

  async handleSaveLeadRequest(leadData, sendResponse) {
    const customName = prompt('Enter custom name for this lead:', leadData.name || leadData.company || 'New Lead');
    if (customName === null || customName.trim() === '') {
      sendResponse({ saved: false, reason: 'cancelled' });
      return;
    }

    const preparedLead = {
      ...this.sanitizeLeadForStorage(leadData),
      name: customName.trim(),
      id: this.generateId(),
      contacted: false,
      contactedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: leadData.source || document.title.slice(0, 100)
    };

    // Check for duplicate
    if (this.isDuplicateLead(preparedLead)) {
      this.showToast('Lead already exists (duplicate)', 'warning');
      sendResponse({ saved: false, reason: 'duplicate' });
      return;
    }

    await Storage.addLead(preparedLead);
    await this.loadLeads();
    this.updateCounts();
    this.showToast(`"${customName}" saved to dashboard!`, 'success');
    sendResponse({ saved: true, leadId: preparedLead.id });
  }

  renderExtractionSettings() {
    document.getElementById('maxLeadsInput').value = this.extractionSettings.limit;
    document.getElementById('noLimitInput').checked = this.extractionSettings.noLimit;
    document.getElementById('requirePhoneInput').checked = this.extractionSettings.requirePhone;
    // ADDED: Note about requirePhone for Maps
    const phoneNote = document.getElementById('phoneNote');
    if (phoneNote) {
      phoneNote.textContent = 'Note: Disabling "Require Phone" recommended for Google Maps (few listings show phones)';
      phoneNote.style.display = 'block';
    }
    document.getElementById('countryCodeInput').value = this.getCountryCodeDigits(this.extractionSettings.countryCode);
    document.getElementById('whatsAppMessageInput').value = this.extractionSettings.whatsAppMessage;
    document.getElementById('maxLeadsInput').disabled = this.extractionSettings.noLimit;
    this.setExtractionStatus('Ready to scan current page');
  }

  renderVersion() {
    const versionBadge = document.getElementById('versionBadge');
    if (versionBadge) {
      versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;
    }
  }

  async handleLimitChange() {
    await this.saveExtractionSettings();
  }

  async handleNoLimitChange() {
    document.getElementById('maxLeadsInput').disabled = document.getElementById('noLimitInput').checked;
    await this.saveExtractionSettings();
  }

  async handleRequirePhoneChange() {
    await this.saveExtractionSettings();
  }

  handleCountryCodeInput(event) {
    event.target.value = this.getCountryCodeDigits(event.target.value);
  }

  async handleCountryCodeChange() {
    const input = document.getElementById('countryCodeInput');
    input.value = this.getCountryCodeDigits(input.value);
    await this.saveExtractionSettings();
  }

  async handleWhatsAppMessageChange() {
    const input = document.getElementById('whatsAppMessageInput');
    if (!input.value.trim()) {
      input.value = LeadExtractor.DEFAULT_WHATSAPP_MESSAGE;
    }
    await this.saveExtractionSettings();
  }

  async requestSaveCurrentLead() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) {
        this.showToast('No active tab found', 'error');
        return;
      }

      this.showToast('Requesting lead data from page...', 'info');
      const response = await chrome.tabs.sendMessage(tabs[0].id, { action: 'saveLeadRequest' });
      if (response.saved) {
        this.showToast('Lead saved successfully!', 'success');
      }
    } catch (error) {
      console.error('Save lead error:', error);
      this.showToast('Page not compatible or content script not loaded', 'error');
    }
  }

  // Lead extraction
  async startExtraction() {
    if (this.isExtracting) return;

    this.isExtracting = true;
    this.currentSessionSaved = 0;
    this.autoExportOnStop = false;
    this.updateExtractionButtons();
    this.showProgress(0);
    this.setExtractionStatus('Starting extraction...');

    try {
      const tab = await this.getExtractionTab();
      if (!tab?.id) {
        throw new Error('No active tab found');
      }

      await this.saveExtractionSettings();
      if (!this.extractionSettings.countryCode) {
        throw new Error('Enter country code in + format, for example +91');
      }

      this.currentTabId = tab.id;
      this.activeSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Send message to content script
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'extract',
        sessionId: this.activeSessionId,
        options: {
          maxLeads: this.extractionSettings.noLimit ? null : this.extractionSettings.limit,
          noLimit: this.extractionSettings.noLimit,
          requirePhone: this.extractionSettings.requirePhone
        }
      });

      if (response?.error) {
        throw new Error(response.error);
      }

      if (Array.isArray(response?.leads) && response.leads.length > 0) {
        const saved = await this.ingestLeads(response.leads);
        this.currentSessionSaved += saved;
      }

      await this.loadLeads();
      this.updateCounts();
      this.showProgress(100);

      const finalCount = response?.savedCount ?? this.currentSessionSaved;
      if (finalCount > 0) {
        const statusText = response?.stopped
          ? `Stopped after saving ${finalCount} business leads`
          : `Extraction completed with ${finalCount} business leads`;
        this.setExtractionStatus(statusText);
        if (response?.stopped && this.autoExportOnStop) {
          this.exportCSV();
          this.autoExportOnStop = false;
        }
        this.showToast(`Extracted ${finalCount} business leads`, 'success');
      } else {
        // FIXED: Better 0-leads guidance for Maps
        const tips = [
          '✓ Make sure Google Maps results are visible',
          '✓ Check Developer Console (F12) for [EXTRACT] logs',
          '✓ Uncheck "Phone only" filter (most listings show no phone)',
          '✓ Scroll down to load more results before extracting',
          '✓ Try a broader search term on Google Maps'
        ].join('\\n');
        this.setExtractionStatus(`No business listings found. Tips:\\n${tips}`);
        this.showToast('No listings extracted. See Console (F12) → [EXTRACT] logs', 'warning');
      }
    } catch (error) {
      console.error('Extraction error:', error);
      this.setExtractionStatus(error.message || 'Extraction failed');
      this.showToast(error.message || 'Extraction failed', 'error');
    } finally {
      this.isExtracting = false;
      this.activeSessionId = null;
      this.currentTabId = null;
      this.currentSessionSaved = 0;
      this.updateExtractionButtons();
      setTimeout(() => this.hideProgress(), 800);
    }
  }

  async stopExtraction() {
    if (!this.isExtracting || !this.currentTabId) return;

    this.autoExportOnStop = true;
    this.setExtractionStatus('Stopping extraction and exporting saved leads...');

    try {
      await chrome.tabs.sendMessage(this.currentTabId, {
        action: 'stopExtraction',
        sessionId: this.activeSessionId
      });
    } catch (error) {
      console.error('Stop extraction error:', error);
    }
  }

  updateExtractionButtons() {
    document.getElementById('startExtraction').disabled = this.isExtracting;
    document.getElementById('stopExtraction').disabled = !this.isExtracting;
  }

  async getExtractionTab() {
    const activeTabs = await chrome.tabs.query({ active: true });
    return activeTabs.find((tab) => tab.id && tab.url && !tab.url.startsWith('chrome-extension://')) || null;
  }

  // Deduplication
  async deduplicate() {
    const originalCount = this.leads.length;
    this.leads = Deduplicator.deduplicate(this.leads);
    const removedCount = originalCount - this.leads.length;

    // Rebuild IndexedDB
    await Storage.clearAllLeads();
    for (const lead of this.leads) {
      await Storage.addLead(lead);
    }

    await this.loadLeads();
    this.updateCounts();
    this.showToast(`Removed ${removedCount} duplicate leads`, 'success');
  }

  async ingestLeads(rawLeads = []) {
    let saved = 0;

    for (const rawLead of rawLeads) {
      const preparedLead = {
        ...this.sanitizeLeadForStorage(rawLead),
        id: this.generateId(),
        contacted: false,
        contactedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      if (this.isDuplicateLead(preparedLead)) {
        continue;
      }

      await Storage.addLead(preparedLead);
      this.leads.unshift(preparedLead);
      saved += 1;
    }

    this.filteredLeads = [...this.leads];
    this.applyLeadFilters();
    this.updateCounts();
    return saved;
  }

  isDuplicateLead(candidate) {
    const candidateEmail = candidate.email?.toLowerCase().trim();
    const candidatePhone = candidate.phone?.replace(/\D/g, '');
    const candidateCompanyName = `${candidate.company || ''}_${candidate.name || ''}`.toLowerCase().trim();

    return this.leads.some((lead) => {
      const leadEmail = lead.email?.toLowerCase().trim();
      const leadPhone = lead.phone?.replace(/\D/g, '');
      const leadCompanyName = `${lead.company || ''}_${lead.name || ''}`.toLowerCase().trim();

      return (
        (candidateEmail && leadEmail && candidateEmail === leadEmail) ||
        (candidatePhone && leadPhone && candidatePhone === leadPhone) ||
        (candidateCompanyName !== '_' && candidateCompanyName === leadCompanyName)
      );
    });
  }

  async handleExtractionProgress(message) {
    if (!this.isExtracting || message.sessionId !== this.activeSessionId) {
      return;
    }

    if (Array.isArray(message.leads) && message.leads.length > 0) {
      const saved = await this.ingestLeads(message.leads);
      this.currentSessionSaved += saved;
    }

    if (typeof message.percent === 'number') {
      this.showProgress(Math.max(0, Math.min(100, message.percent)));
    }

    if (message.statusText) {
      this.setExtractionStatus(message.statusText);
    }

    if (message.complete && this.autoExportOnStop && this.currentSessionSaved > 0) {
      await this.loadLeads();
      this.exportCSV();
      this.autoExportOnStop = false;
    }
  }

  async handleLeadsCleared() {
    await this.loadLeads();
    this.updateCounts();
    this.setExtractionStatus('Saved leads cleared after page refresh');
  }

  filterLeads(query) {
    this.searchQuery = query;
    this.applyLeadFilters();
  }

  filterByType(type) {
    this.typeFilter = type;
    this.applyLeadFilters();
  }

  applyLeadFilters() {
    const searchTerm = this.searchQuery.toLowerCase().trim();

    const filtered = this.leads.filter((lead) => {
      const matchesSearch = !searchTerm || [
        lead.name,
        lead.email,
        lead.phone,
        lead.company,
        lead.jobTitle,
        lead.website,
        lead.address
      ].some((value) => value?.toLowerCase().includes(searchTerm));

      if (!matchesSearch) {
        return false;
      }

      switch (this.typeFilter) {
        case 'email':
          return Boolean(lead.email);
        case 'phone':
          return Boolean(lead.phone);
        case 'company':
          return Boolean(lead.company);
        case 'rating':
          return this.getRatingValue(lead.rating) > 0;
        default:
          return true;
      }
    });

    this.filteredLeads = this.typeFilter === 'rating'
      ? filtered.sort((a, b) => this.getRatingValue(b.rating) - this.getRatingValue(a.rating))
      : filtered;

    this.renderLeads(true);
  }

  // Lead display
  renderLeads(reset = false) {
    const container = document.getElementById('leadsList');
    const listStatus = document.getElementById('listStatus');

    if (this.filteredLeads.length === 0) {
      const emptyMessage = this.leads.length > 0
        ? 'No leads match the current filters'
        : 'No leads extracted yet';
      container.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
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
    if (nextBatch.length === 0) {
      this.updateListStatus();
      return;
    }

    const markup = nextBatch.map((lead) => `
      <div class="lead-row ${lead.contacted ? 'contacted' : ''}" data-id="${lead.id}">
        <div class="lead-info">
          <div class="lead-name">${lead.name || 'Unknown'}</div>
          <div class="lead-details">
            ${lead.phone || lead.website || lead.address || lead.category || lead.company || 'No details'}
          </div>
          <div class="lead-meta">
            ${lead.contacted ? `Contacted${lead.contactedAt ? ` on ${new Date(lead.contactedAt).toLocaleDateString()}` : ''}` : 'Not contacted yet'}
            ${lead.source ? `<div class="lead-source">${lead.source.slice(0, 40)}${lead.source.length > 40 ? '...' : ''}</div>` : ''}
          </div>
        </div>
        <div class="lead-actions">
          <button type="button" class="lead-action-btn whatsapp" title="Send WhatsApp" data-action="whatsapp" data-id="${lead.id}"
            ${this.hasWhatsAppNumber(lead) ? '' : 'disabled'}>WA</button>
          <button type="button" class="lead-action-btn contact ${lead.contacted ? 'active' : ''}" title="Mark contacted" data-action="contact" data-id="${lead.id}">
            ${lead.contacted ? '✓' : '☐'}
          </button>
          <button type="button" class="lead-action-btn edit" title="Edit" data-action="edit" data-id="${lead.id}">✏</button>
          <button type="button" class="lead-action-btn delete" title="Delete" data-action="delete" data-id="${lead.id}">🗑</button>
        </div>
      </div>
    `).join('');

    container.insertAdjacentHTML('beforeend', markup);
    this.renderedLeadCount += nextBatch.length;
    this.updateListStatus();

    if (container.scrollHeight <= container.clientHeight && this.renderedLeadCount < this.filteredLeads.length) {
      this.renderLeads();
    }
  }

  handleLeadListScroll() {
    const container = document.getElementById('leadsList');
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;

    if (remaining <= 48) {
      this.renderLeads();
    }
  }

  handleLeadActionClick(event) {
    const button = event.target.closest('button[data-action][data-id]');
    if (!button || button.disabled) {
      return;
    }

    const { action, id } = button.dataset;
    switch (action) {
      case 'whatsapp':
        this.openWhatsApp(id);
        break;
      case 'contact':
        this.toggleContacted(id);
        break;
      case 'edit':
        this.editLead(id);
        break;
      case 'delete':
        this.deleteLead(id);
        break;
      default:
        break;
    }
  }

  updateListStatus() {
    const listStatus = document.getElementById('listStatus');

    if (!this.filteredLeads.length) {
      listStatus.textContent = '';
      return;
    }

    const hasMore = this.renderedLeadCount < this.filteredLeads.length;
    listStatus.textContent = hasMore
      ? `Showing ${this.renderedLeadCount} of ${this.filteredLeads.length}`
      : `Showing all ${this.filteredLeads.length}`;
  }

  // Lead management
  async deleteLead(id) {
    await Storage.deleteLead(id);
    await this.loadLeads();
    this.updateCounts();
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

    const updatedLead = {
      ...this.leads.find((lead) => lead.id === id),
      id,
      name: form.name.value,
      email: form.email.value,
      phone: form.phone.value,
      company: form.company.value,
      jobTitle: form.jobTitle.value,
      website: form.website.value,
      address: form.address.value,
      updatedAt: Date.now()
    };

    await Storage.updateLead(updatedLead);
    await this.loadLeads();
    this.updateCounts();
    this.closeEditModal();
    this.showToast('Lead updated', 'success');
  }

  closeEditModal() {
    document.getElementById('editLeadModal').style.display = 'none';
  }

  async handleAddLead(e) {
    e.preventDefault();
    const form = e.target;

    const newLead = {
      id: this.generateId(),
      name: form.name.value,
      email: form.email.value,
      phone: form.phone.value,
      company: form.company.value,
      jobTitle: form.jobTitle.value,
      website: form.website.value,
      address: form.address.value,
      contacted: false,
      contactedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await Storage.addLead(newLead);
    await this.loadLeads();
    this.updateCounts();
    this.closeModal();
    this.showToast('Lead added', 'success');
    form.reset();
  }

  closeModal() {
    document.getElementById('addLeadModal').style.display = 'none';
  }

  async clearAll() {
    if (!confirm('Are you sure you want to delete all leads?')) return;

    await Storage.clearAllLeads();
    this.leads = [];
    this.filteredLeads = [];
    this.renderLeads(true);
    this.updateCounts();
    this.showToast('All leads cleared', 'success');
  }

  // Export methods
  exportCSV() {
    if (this.leads.length === 0) {
      this.showToast('No leads to export', 'error');
      return;
    }

    const data = this.leads.map((lead) => this.buildExportRow(lead));

    const csv = Papa.unparse(data);
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    this.downloadBlob(blob, 'leads.csv');
    this.showToast('CSV exported', 'success');
  }

  exportExcel() {
    if (this.leads.length === 0) {
      this.showToast('No leads to export', 'error');
      return;
    }

    const data = this.leads.map((lead) => this.buildExportRow(lead));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const headers = Object.keys(data[0] || {});
    const whatsAppColumnIndex = headers.indexOf('WhatsApp URL');

    if (whatsAppColumnIndex >= 0) {
      this.addWorksheetHyperlinks(worksheet, data, whatsAppColumnIndex, 'Open Chat');
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');

    // Auto-fit columns
    const colWidths = Object.keys(data[0] || {}).map(key => ({
      wch: Math.max(key.length, ...data.map(row => String(row[key] || '').length))
    }));
    worksheet['!cols'] = colWidths;

    XLSX.writeFile(workbook, 'leads.xlsx');
    this.showToast('Excel exported', 'success');
  }

  // Utility methods
  generateId() {
    return 'lead_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  sanitizeLeadForStorage(rawLead = {}) {
    return {
      name: rawLead.name || '',
      phone: rawLead.phone || '',
      company: rawLead.company || '',
      category: rawLead.category || '',
      rating: rawLead.rating || '',
      reviews: rawLead.reviews || '',
      website: rawLead.website || '',
      address: rawLead.address || ''
    };
  }

  buildExportRow(lead) {
    return {
      Name: lead.name || '',
      Phone: lead.phone || '',
      Company: lead.company || '',
      Category: lead.category || '',
      Rating: lead.rating || '',
      Reviews: lead.reviews || '',
      Website: lead.website || '',
      Address: lead.address || '',
      'WhatsApp URL': this.buildWhatsAppUrl(lead),
      Contacted: lead.contacted ? 'Yes' : 'No',
      'Contacted Date': lead.contactedAt ? new Date(lead.contactedAt).toISOString() : ''
    };
  }

  normalizeStoredLead(lead) {
    return {
      ...lead,
      contacted: Boolean(lead.contacted),
      contactedAt: lead.contactedAt || null
    };
  }

  getWhatsAppMessage() {
    const input = document.getElementById('whatsAppMessageInput');
    return input?.value?.trim() || LeadExtractor.DEFAULT_WHATSAPP_MESSAGE;
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

  formatPhoneForWhatsApp(phone) {
    const digits = (phone || '').replace(/\D/g, '');
    if (!digits) {
      return '';
    }

    const countryCodeDigits = this.extractionSettings?.countryCode?.replace(/\D/g, '') || '';
    if (!countryCodeDigits) {
      return digits;
    }

    const trimmedPhone = (phone || '').trim();
    if (trimmedPhone.startsWith('+')) {
      return digits;
    }

    if (digits.startsWith(countryCodeDigits) && digits.length > Math.max(countryCodeDigits.length + 6, 10)) {
      return digits;
    }

    const localDigits = digits.replace(/^0+/, '') || digits;
    return `${countryCodeDigits}${localDigits}`;
  }

  hasWhatsAppNumber(lead) {
    return this.formatPhoneForWhatsApp(lead.phone).length >= 10;
  }

  buildWhatsAppUrl(lead) {
    const phone = this.formatPhoneForWhatsApp(lead.phone);
    if (!phone) {
      return '';
    }

    const text = encodeURIComponent(this.getWhatsAppMessage());
    return `https://wa.me/${phone}?text=${text}`;
  }

  addWorksheetHyperlinks(worksheet, data, columnIndex, label) {
    data.forEach((row, rowIndex) => {
      const url = row['WhatsApp URL'];
      if (!url) {
        return;
      }

      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex });
      worksheet[cellAddress] = {
        t: 's',
        v: label,
        l: { Target: url, Tooltip: url },
        s: {
          font: { color: { rgb: '0563C1' }, underline: true }
        }
      };
    });
  }

  async openWhatsApp(id) {
    const lead = this.leads.find((item) => item.id === id);
    if (!lead || !this.hasWhatsAppNumber(lead)) {
      this.showToast('No valid phone number for WhatsApp', 'error');
      return;
    }

    await this.saveExtractionSettings();
    const url = this.buildWhatsAppUrl(lead);
    if (!url) {
      this.showToast('WhatsApp link could not be generated', 'error');
      return;
    }

    try {
      await chrome.tabs.create({ url, active: true });
    } catch (error) {
      window.open(url, '_blank', 'noopener');
    }

    this.showToast('WhatsApp link opened', 'success');
  }

  async toggleContacted(id) {
    const lead = this.leads.find((item) => item.id === id);
    if (!lead) {
      return;
    }

    const updatedLead = {
      ...lead,
      contacted: !lead.contacted,
      contactedAt: !lead.contacted ? Date.now() : null,
      updatedAt: Date.now()
    };

    await Storage.updateLead(updatedLead);
    this.leads = this.leads.map((item) => item.id === id ? updatedLead : item);
    this.applyLeadFilters();
    this.showToast(updatedLead.contacted ? 'Lead marked as contacted' : 'Contacted mark removed', 'success');
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
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return filename.replace('.', `_${timestamp}.`);
  }

  updateCounts() {
    document.getElementById('leadCount').textContent = `${this.leads.length} leads`;
  }

  setExtractionStatus(message) {
    document.getElementById('extractionStatus').textContent = message;
  }

  showProgress(percent) {
    document.getElementById('progressContainer').style.display = 'flex';
    document.getElementById('progressFill').style.width = `${percent}%`;
    document.getElementById('progressText').textContent = `${percent}%`;
  }

  hideProgress() {
    document.getElementById('progressContainer').style.display = 'none';
  }

  showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;

    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }
}

// Initialize app
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new LeadExtractor();
});
