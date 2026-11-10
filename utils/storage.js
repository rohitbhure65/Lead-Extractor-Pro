// Map Leadify - Storage Layer (IndexedDB + chrome.storage.local)

/**
 * @typedef {Object} WhatsAppTemplate
 * @property {string} id
 * @property {string} name
 * @property {string} body
 * @property {number} [createdAt]
 * @property {number} [updatedAt]
 */

/**
 * @typedef {Object} StoredLead
 * @property {string} id
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [phone]
 * @property {string} [company]
 * @property {string} [jobTitle]
 * @property {string} [website]
 * @property {string} [address]
 * @property {string} [category]
 * @property {string} [rating]
 * @property {string} [reviews]
 * @property {string} [status]
 * @property {string} [priceRange]
 * @property {string} [services]
 * @property {string} [hours]
 * @property {string} [rawData]
 * @property {string} [type]
 * @property {boolean} [contacted]
 * @property {number | null} [contactedAt]
 * @property {number} [createdAt]
 * @property {number} [updatedAt]
 * @property {string} [source]
 */

class LeadStorage {
  static DB_NAME = 'LeadExtractorDB';
  static DB_VERSION = 1;
  static STORE_NAME = 'leads';
  /** @type {IDBDatabase | null} */
  static db = null;

  // ── Database Init ───────────────────────────────────────────────────────────
  /** @returns {Promise<void>} */
  static async init() {
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const target = /** @type {IDBOpenDBRequest | null} */ (event.target);
        const db = target?.result;
        if (!db) return;

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

  /** @returns {Promise<IDBDatabase>} */
  static async ensureDB() {
    if (!this.db) await this.init();
    if (!this.db) throw new Error('IndexedDB not initialized');
    return this.db;
  }

  // ── chrome.storage.local helpers ────────────────────────────────────────────
  /**
   * @param {string} key
   * @returns {Promise<any>}
   */
  static async get(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => resolve(result[key]));
    });
  }

  /**
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  static async set(key, value) {
    return new Promise((/** @type {(value?: void) => void} */ resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    });
  }

  /**
   * @param {string} key
   * @returns {Promise<void>}
   */
  static async remove(key) {
    return new Promise((/** @type {(value?: void) => void} */ resolve) => {
      chrome.storage.local.remove(key, () => resolve());
    });
  }

  // ── WhatsApp Templates ──────────────────────────────────────────────────────
  static TEMPLATES_KEY = 'whatsappTemplates';
  static DEFAULT_TEMPLATE_KEY = 'defaultTemplateId';

  /** @returns {Promise<WhatsAppTemplate[]>} */
  static async getTemplates() {
    const templates = await this.get(this.TEMPLATES_KEY);
    return Array.isArray(templates) ? templates : [];
  }

  /**
   * @param {WhatsAppTemplate[]} templates
   * @returns {Promise<void>}
   */
  static async saveTemplates(templates) {
    await this.set(this.TEMPLATES_KEY, templates);
  }

  /** @returns {Promise<string | null | undefined>} */
  static async getDefaultTemplateId() {
    return await this.get(this.DEFAULT_TEMPLATE_KEY);
  }

  /**
   * @param {string | null} id
   * @returns {Promise<void>}
   */
  static async setDefaultTemplateId(id) {
    await this.set(this.DEFAULT_TEMPLATE_KEY, id);
  }

  /**
   * @param {WhatsAppTemplate} template
   * @returns {Promise<WhatsAppTemplate[]>}
   */
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

  /**
   * @param {WhatsAppTemplate} updatedTemplate
   * @returns {Promise<WhatsAppTemplate[]>}
   */
  static async updateTemplate(updatedTemplate) {
    const templates = await this.getTemplates();
    const index = templates.findIndex(t => t.id === updatedTemplate.id);
    if (index !== -1) templates[index] = updatedTemplate;
    await this.saveTemplates(templates);
    return templates;
  }

  /**
   * @param {string} id
   * @returns {Promise<WhatsAppTemplate[]>}
   */
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
  /**
   * @param {StoredLead} lead
   * @returns {Promise<void>}
   */
  static async addLead(lead) {
    const db = await this.ensureDB();
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readwrite');
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

  /** @returns {Promise<StoredLead[]>} */
  static async getAllLeads() {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<StoredLead | undefined>}
   */
  static async getLead(id) {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * @param {StoredLead} lead
   * @returns {Promise<void>}
   */
  static async updateLead(lead) {
    const db = await this.ensureDB();
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.put(lead);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  static async deleteLead(id) {
    const db = await this.ensureDB();
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /** @returns {Promise<void>} */
  static async clearAllLeads() {
    const db = await this.ensureDB();
    return new Promise((/** @type {(value?: void) => void} */ resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /** @returns {Promise<number>} */
  static async getCount() {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([this.STORE_NAME], 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

// Initialize storage on load
LeadStorage.init().catch(console.error);
