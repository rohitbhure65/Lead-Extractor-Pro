// Lead Extractor Pro - Storage Layer (IndexedDB + chrome.storage.local)

class Storage {
  static DB_NAME = 'LeadExtractorDB';
  static DB_VERSION = 1;
  static STORE_NAME = 'leads';
  static db = null;

  // ── Database Init ───────────────────────────────────────────────────────────
  static async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
          store.createIndex('email', 'email', { unique: false });
          store.createIndex('company', 'company', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('phone', 'phone', { unique: false });
        }
      };
    });
  }

  static async ensureDB() {
    if (!this.db) await this.init();
  }

  // ── chrome.storage.local helpers ────────────────────────────────────────────
  static async get(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => resolve(result[key]));
    });
  }

  static async set(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  }

  static async remove(key) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, resolve);
    });
  }

  // ── WhatsApp Templates ──────────────────────────────────────────────────────
  static TEMPLATES_KEY = 'whatsappTemplates';
  static DEFAULT_TEMPLATE_KEY = 'defaultTemplateId';

  static async getTemplates() {
    const templates = await this.get(this.TEMPLATES_KEY);
    return Array.isArray(templates) ? templates : [];
  }

  static async saveTemplates(templates) {
    await this.set(this.TEMPLATES_KEY, templates);
  }

  static async getDefaultTemplateId() {
    return await this.get(this.DEFAULT_TEMPLATE_KEY);
  }

  static async setDefaultTemplateId(id) {
    await this.set(this.DEFAULT_TEMPLATE_KEY, id);
  }

  static async addTemplate(template) {
    const templates = await this.getTemplates();
    templates.push(template);
    await this.saveTemplates(templates);
    // If first template, set as default
    if (templates.length === 1) {
      await this.setDefaultTemplateId(template.id);
    }
    return templates;
  }

  static async updateTemplate(updatedTemplate) {
    const templates = await this.getTemplates();
    const index = templates.findIndex(t => t.id === updatedTemplate.id);
    if (index !== -1) templates[index] = updatedTemplate;
    await this.saveTemplates(templates);
    return templates;
  }

  static async deleteTemplate(id) {
    let templates = await this.getTemplates();
    templates = templates.filter(t => t.id !== id);
    await this.saveTemplates(templates);

    // If deleted was default, set new default or null
    const currentDefault = await this.getDefaultTemplateId();
    if (currentDefault === id) {
      await this.setDefaultTemplateId(templates.length > 0 ? templates[0].id : null);
    }

    return templates;
  }

  // ── Lead CRUD ───────────────────────────────────────────────────────────────
  static async addLead(lead) {
    await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.add(lead);
      request.onsuccess = () => resolve();
      request.onerror = () => {
        // Ignore duplicate key errors gracefully
        if (request.error?.name === 'ConstraintError') {
          resolve();
        } else {
          reject(request.error);
        }
      };
    });
  }

  static async getAllLeads() {
    await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  static async getLead(id) {
    await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  static async updateLead(lead) {
    await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.put(lead);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  static async deleteLead(id) {
    await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  static async clearAllLeads() {
    await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  static async getCount() {
    await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

// Initialize storage on load
Storage.init().catch(console.error);