// Lead Extractor Pro - Deduplication Logic

class Deduplicator {
  // Deduplicate leads by email, phone, or company+name
  static deduplicate(leads, options = {}) {
    const {
      keepFirst = true // Keep first or last occurrence
    } = options;

    const seen = new Map();
    const result = [];

    // Define deduplication keys in priority order
    const getPrimaryKey = (lead) => lead.email?.toLowerCase().trim();
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
        const companyName = (lead.company + '_' + lead.name).toLowerCase().trim();
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
  static getDuplicateGroups(leads) {
    const groups = [];
    const seen = new Map();

    // Group by email
    const emailGroups = new Map();
    leads.forEach(lead => {
      const email = lead.email?.toLowerCase().trim();
      if (email) {
        if (!emailGroups.has(email)) {
          emailGroups.set(email, []);
        }
        emailGroups.get(email).push(lead);
      }
    });

    // Group by phone
    const phoneGroups = new Map();
    leads.forEach(lead => {
      const phone = lead.phone?.replace(/\D/g, '');
      if (phone) {
        if (!phoneGroups.has(phone)) {
          phoneGroups.set(phone, []);
        }
        phoneGroups.get(phone).push(lead);
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
  static mergeDuplicates(leads) {
    const primaryKeyMap = new Map();
    
    leads.forEach(lead => {
      const key = lead.email?.toLowerCase().trim() || lead.phone?.replace(/\D/g, '') || '';
      if (!key) return;
      
      if (!primaryKeyMap.has(key)) {
        primaryKeyMap.set(key, lead);
      } else {
        const existing = primaryKeyMap.get(key);
        
        // Merge non-empty fields
        existing.name = existing.name || lead.name;
        existing.company = existing.company || lead.company;
        existing.jobTitle = existing.jobTitle || lead.jobTitle;
        existing.website = existing.website || lead.website;
        existing.address = existing.address || lead.address;
        
        // Keep most recent timestamp
        if (lead.createdAt > existing.createdAt) {
          existing.createdAt = lead.createdAt;
        }
      }
    });

    return Array.from(primaryKeyMap.values());
  }
}