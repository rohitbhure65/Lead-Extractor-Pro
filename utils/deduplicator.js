// Map Leadify - Deduplication Logic

/**
 * @typedef {Object} DuplicateGroup
 * @property {'email' | 'phone'} type
 * @property {string} key
 * @property {StoredLead[]} leads
 */

class Deduplicator {
  // Deduplicate leads by email, phone, or company+name
  /**
   * @param {StoredLead[]} leads
   * @param {{ keepFirst?: boolean }} [options]
   * @returns {StoredLead[]}
   */
  static deduplicate(leads, options = {}) {
    const {
      keepFirst = true // Keep first or last occurrence
    } = options;

    /** @type {Map<string, string>} */
    const seen = new Map();
    /** @type {StoredLead[]} */
    const result = [];

    // Define deduplication keys in priority order
    /** @param {StoredLead} lead */
    const getPrimaryKey = (lead) => lead.email?.toLowerCase().trim();
    /** @param {StoredLead} lead */
    const getSecondaryKey = (lead) => lead.phone?.replace(/\D/g, '');

    for (const lead of leads) {
      let duplicate = false;

      // Check email first
      const email = getPrimaryKey(lead);
      if (email) {
        if (seen.has('email:' + email)) {
          duplicate = true;
        } else {
          seen.set('email:' + email, lead.id);
        }
      }

      // Check phone as secondary
      if (!duplicate) {
        const phone = getSecondaryKey(lead);
        if (phone) {
          if (seen.has('phone:' + phone)) {
            duplicate = true;
          } else {
            seen.set('phone:' + phone, lead.id);
          }
        }
      }

      // Check company + name combination as tertiary
      if (!duplicate) {
        const companyName = ((lead.company || '') + '_' + (lead.name || '')).toLowerCase().trim();
        if (companyName !== '_') {
          if (seen.has('companyName:' + companyName)) {
            duplicate = true;
          } else {
            seen.set('companyName:' + companyName, lead.id);
          }
        }
      }

      if (!duplicate) {
        result.push(lead);
      } else if (!keepFirst) {
        // Replace with newer version
        const existingIndex = result.findIndex(l =>
          (lead.email && l.email?.toLowerCase() === lead.email?.toLowerCase()) ||
          (lead.phone && l.phone?.replace(/\D/g, '') === lead.phone?.replace(/\D/g, ''))
        );

        if (existingIndex !== -1) {
          result[existingIndex] = lead;
        }
      }
    }

    return result;
  }

  // Get duplicate groups
  /**
   * @param {StoredLead[]} leads
   * @returns {DuplicateGroup[]}
   */
  static getDuplicateGroups(leads) {
    /** @type {DuplicateGroup[]} */
    const groups = [];

    // Group by email
    /** @type {Map<string, StoredLead[]>} */
    const emailGroups = new Map();
    leads.forEach(lead => {
      const email = lead.email?.toLowerCase().trim();
      if (email) {
        let bucket = emailGroups.get(email);
        if (!bucket) {
          bucket = [];
          emailGroups.set(email, bucket);
        }
        bucket.push(lead);
      }
    });

    // Group by phone
    /** @type {Map<string, StoredLead[]>} */
    const phoneGroups = new Map();
    leads.forEach(lead => {
      const phone = lead.phone?.replace(/\D/g, '');
      if (phone) {
        let bucket = phoneGroups.get(phone);
        if (!bucket) {
          bucket = [];
          phoneGroups.set(phone, bucket);
        }
        bucket.push(lead);
      }
    });

    // Collect groups with duplicates
    emailGroups.forEach((groupLeads, key) => {
      if (groupLeads.length > 1) {
        groups.push({
          type: 'email',
          key,
          leads: groupLeads
        });
      }
    });

    phoneGroups.forEach((groupLeads, key) => {
      if (groupLeads.length > 1) {
        const hasExisting = groups.some(g =>
          g.type === 'phone' && g.key === key
        );
        if (!hasExisting) {
          groups.push({
            type: 'phone',
            key,
            leads: groupLeads
          });
        }
      }
    });

    return groups;
  }

  // Merge duplicate leads, keeping most complete data
  /**
   * @param {StoredLead[]} leads
   * @returns {StoredLead[]}
   */
  static mergeDuplicates(leads) {
    /** @type {Map<string, StoredLead>} */
    const primaryKeyMap = new Map();

    leads.forEach(lead => {
      const key = lead.email?.toLowerCase().trim() || lead.phone?.replace(/\D/g, '') || '';
      if (!key) return;

      const existing = primaryKeyMap.get(key);
      if (!existing) {
        primaryKeyMap.set(key, lead);
      } else {
        // Merge non-empty fields
        existing.name = existing.name || lead.name;
        existing.company = existing.company || lead.company;
        existing.jobTitle = existing.jobTitle || lead.jobTitle;
        existing.website = existing.website || lead.website;
        existing.address = existing.address || lead.address;

        // Keep most recent timestamp
        if ((lead.createdAt || 0) > (existing.createdAt || 0)) {
          existing.createdAt = lead.createdAt;
        }
      }
    });

    return Array.from(primaryKeyMap.values());
  }
}
