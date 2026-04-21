// Lead Extractor Pro - Popup Script

class LeadExtractor {
  static DEFAULT_WHATSAPP_MESSAGE = 'Hi, I found your business details and wanted to connect regarding your services.';

  constructor() {
    this.keywords = [];
    this.leads = [];
    this.filteredLeads = [];
    this.renderedLeadCount = 0;
    this.renderBatchSize = 25;
    this.isExtracting = false;
    this.maxKeywords = 15;
    this.activeSessionId = null;
    this.currentTabId = null;
    this.currentSessionSaved = 0;
    this.autoExportOnStop = false;
    this.searchQuery = '';
    this.typeFilter = 'all';

    this.init();
  }

  async init() {
    await this.loadKeywords();
    await this.loadLeads();
    await this.loadExtractionSettings();
    this.bindEvents();
    this.bindRuntimeListeners();
    this.renderKeywords();
    this.updateCounts();
    this.renderExtractionSettings();
  }

  // Storage methods
  async loadKeywords() {
    this.keywords = await Storage.get('keywords') || [];
  }

  async saveKeywords() {
    await Storage.set('keywords', this.keywords);
  }

  async loadExtractionSettings() {
    const saved = await Storage.get('extractionSettings');
    this.extractionSettings = {
      limit: saved?.limit || 100,
      noLimit: Boolean(saved?.noLimit),
      requirePhone: Boolean(saved?.requirePhone),
      whatsAppMessage: saved?.whatsAppMessage?.trim() || LeadExtractor.DEFAULT_WHATSAPP_MESSAGE
    };
  }

  async saveExtractionSettings() {
    const limitInput = document.getElementById('maxLeadsInput');
    const noLimitInput = document.getElementById('noLimitInput');
    const parsedLimit = parseInt(limitInput.value, 10);

    this.extractionSettings = {
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100,
      noLimit: noLimitInput.checked,
      requirePhone: document.getElementById('requirePhoneInput').checked,
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
    // Keywords
    document.getElementById('addKeyword').addEventListener('click', () => this.addKeyword());
    document.getElementById('keywordInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.addKeyword();
    });
    document.getElementById('clearKeywords').addEventListener('click', () => this.clearKeywords());

    // Extraction
    document.getElementById('startExtraction').addEventListener('click', () => this.startExtraction());
    document.getElementById('stopExtraction').addEventListener('click', () => this.stopExtraction());
    document.getElementById('deduplicate').addEventListener('click', () => this.deduplicate());
    document.getElementById('maxLeadsInput').addEventListener('change', () => this.handleLimitChange());
    document.getElementById('noLimitInput').addEventListener('change', () => this.handleNoLimitChange());
    document.getElementById('requirePhoneInput').addEventListener('change', () => this.handleRequirePhoneChange());
    document.getElementById('whatsAppMessageInput').addEventListener('change', () => this.handleWhatsAppMessageChange());
    document.getElementById('whatsAppMessageInput').addEventListener('blur', () => this.handleWhatsAppMessageChange());

    // Search & Filter
    document.getElementById('searchInput').addEventListener('input', (e) => this.filterLeads(e.target.value));
    document.getElementById('filterSelect').addEventListener('change', (e) => this.filterByType(e.target.value));
    document.getElementById('leadsList').addEventListener('scroll', () => this.handleLeadListScroll());

    // Export
    document.getElementById('exportCSV').addEventListener('click', () => this.exportCSV());
    document.getElementById('exportExcel').addEventListener('click', () => this.exportExcel());
    document.getElementById('clearAll').addEventListener('click', () => this.clearAll());

    // Modals
    document.getElementById('closeModal').addEventListener('click', () => this.closeModal());
    document.getElementById('addLeadForm').addEventListener('submit', (e) => this.handleAddLead(e));
    document.getElementById('closeEditModal').addEventListener('click', () => this.closeEditModal());
    document.getElementById('editLeadForm').addEventListener('submit', (e) => this.handleEditLead(e));
  }

  bindRuntimeListeners() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.action === 'extractionProgress') {
        this.handleExtractionProgress(message);
      }
    });
  }

  renderExtractionSettings() {
    document.getElementById('maxLeadsInput').value = this.extractionSettings.limit;
    document.getElementById('noLimitInput').checked = this.extractionSettings.noLimit;
    document.getElementById('requirePhoneInput').checked = this.extractionSettings.requirePhone;
    document.getElementById('whatsAppMessageInput').value = this.extractionSettings.whatsAppMessage;
    document.getElementById('maxLeadsInput').disabled = this.extractionSettings.noLimit;
    this.setExtractionStatus('Ready to scan current page');
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

  async handleWhatsAppMessageChange() {
    const input = document.getElementById('whatsAppMessageInput');
    if (!input.value.trim()) {
      input.value = LeadExtractor.DEFAULT_WHATSAPP_MESSAGE;
    }
    await this.saveExtractionSettings();
  }

  // Keyword methods
  addKeyword() {
    const input = document.getElementById('keywordInput');
    const keyword = input.value.trim().toLowerCase();

    if (!keyword) return;
    if (this.keywords.includes(keyword)) {
      this.showToast('Keyword already exists', 'error');
      return;
    }
    if (this.keywords.length >= this.maxKeywords) {
      this.showToast(`Maximum ${this.maxKeywords} keywords allowed`, 'error');
      return;
    }

    this.keywords.push(keyword);
    input.value = '';
    this.saveKeywords();
    this.renderKeywords();
    this.updateCounts();
  }

  removeKeyword(keyword) {
    this.keywords = this.keywords.filter(k => k !== keyword);
    this.saveKeywords();
    this.renderKeywords();
    this.updateCounts();
  }

  clearKeywords() {
    this.keywords = [];
    this.saveKeywords();
    this.renderKeywords();
    this.updateCounts();
  }

  renderKeywords() {
    const container = document.getElementById('keywordsList');
    container.innerHTML = this.keywords.map(keyword => `
      <span class="keyword-tag">
        ${keyword}
        <button type="button" onclick="app.removeKeyword('${keyword}')">&times;</button>
      </span>
    `).join('');
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
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error('No active tab found');
      }

      await this.saveExtractionSettings();
      this.currentTabId = tab.id;
      this.activeSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Send message to content script
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'extract',
        keywords: this.keywords,
        source: tab.url,
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
          ? `Stopped after saving ${finalCount} leads`
          : `Extraction completed with ${finalCount} leads`;
        this.setExtractionStatus(statusText);
        if (response?.stopped && this.autoExportOnStop) {
          this.exportCSV();
          this.autoExportOnStop = false;
        }
        this.showToast(`Extracted ${finalCount} leads`, 'success');
      } else {
        this.setExtractionStatus('No leads found on this page');
        this.showToast('No leads found on this page', 'error');
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
        ...rawLead,
        id: this.generateId(),
        keywords: this.matchKeywords(rawLead),
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

    this.filteredLeads = this.leads.filter((lead) => {
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
        default:
          return true;
      }
    });

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
          </div>
        </div>
        <div class="lead-actions">
          <button class="lead-action-btn whatsapp" title="Send WhatsApp" onclick="app.openWhatsApp('${lead.id}')"
            ${this.hasWhatsAppNumber(lead) ? '' : 'disabled'}>WA</button>
          <button class="lead-action-btn contact ${lead.contacted ? 'active' : ''}" title="Mark contacted" onclick="app.toggleContacted('${lead.id}')">
            ${lead.contacted ? '✓' : '☐'}
          </button>
          <button class="lead-action-btn edit" title="Edit" onclick="app.editLead('${lead.id}')">✏</button>
          <button class="lead-action-btn delete" title="Delete" onclick="app.deleteLead('${lead.id}')">🗑</button>
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
      keywords: [],
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

    const data = this.leads.map(lead => ({
      Name: lead.name || '',
      Email: lead.email || '',
      Phone: lead.phone || '',
      Company: lead.company || '',
      Category: lead.category || '',
      Rating: lead.rating || '',
      Reviews: lead.reviews || '',
      Status: lead.status || '',
      Services: lead.services || '',
      'Job Title': lead.jobTitle || '',
      Website: lead.website || '',
      Address: lead.address || '',
      'Source URL': lead.source || '',
      'Matched Keywords': lead.keywords?.join(', ') || '',
      'Extracted Date': new Date(lead.createdAt).toISOString(),
      'WhatsApp URL': this.buildWhatsAppUrl(lead),
      'Contacted': lead.contacted ? 'Yes' : 'No',
      'Contacted Date': lead.contactedAt ? new Date(lead.contactedAt).toISOString() : ''
    }));

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

    const data = this.leads.map(lead => ({
      Name: lead.name || '',
      Email: lead.email || '',
      Phone: lead.phone || '',
      Company: lead.company || '',
      Category: lead.category || '',
      Rating: lead.rating || '',
      Reviews: lead.reviews || '',
      Status: lead.status || '',
      Services: lead.services || '',
      'Job Title': lead.jobTitle || '',
      Website: lead.website || '',
      Address: lead.address || '',
      'Source URL': lead.source || '',
      'Matched Keywords': lead.keywords?.join(', ') || '',
      'Extracted Date': new Date(lead.createdAt).toISOString(),
      'WhatsApp URL': this.buildWhatsAppUrl(lead),
      'Contacted': lead.contacted ? 'Yes' : 'No',
      'Contacted Date': lead.contactedAt ? new Date(lead.contactedAt).toISOString() : ''
    }));

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

  matchKeywords(lead) {
    if (!this.keywords.length) return [];

    const text = [lead.name, lead.company, lead.jobTitle, lead.email]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return this.keywords.filter(keyword => text.includes(keyword));
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

  formatPhoneForWhatsApp(phone) {
    return (phone || '').replace(/\D/g, '');
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
    await chrome.tabs.create({ url });
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
    document.getElementById('keywordCount').textContent = `${this.keywords.length}/${this.maxKeywords}`;
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
