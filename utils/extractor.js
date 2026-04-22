// Lead Extractor Pro - Extraction Logic

class Extractor {
  // Email pattern
  static EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  
  // Phone patterns (various formats)
  // Phone patterns (broadly matches international formats)
  static PHONE_REGEX = /(?:\+?\d{1,4}[\s\-.()]{0,3})?(?:\d[\s\-.()]{0,3}){9,15}/g;
  
  // Website pattern
  static WEBSITE_REGEX = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
  
  // LinkedIn profile pattern
  static LINKEDIN_REGEX = /linkedin\.com\/in\/[a-zA-Z0-9-]+/gi;
  
  // Common name patterns
  static NAME_SELECTORS = [
    'h1', 'h2', 'h3', '[itemprop="name"]', '.name', '#name', 
    '.author', '.profile-name', '.person-name', '[class*="name"]'
  ];

  // Company selectors
  static COMPANY_SELECTORS = [
    '[itemprop="name"]', '.company', '#company', '.organization',
    '[class*="company"]', '[class*="org"]'
  ];

  // Job title selectors
  static JOB_TITLE_SELECTORS = [
    '[itemprop="jobTitle"]', '.job-title', '.title', '.position',
    '[class*="title"]', '[class*="position"]'
  ];

  // Extract all leads from page
  static extractFromPage(keywords = [], source = '') {
    const leads = [];
    
    // Extract from different sources
    leads.push(...this.extractFromContactLinks());
    leads.push(...this.extractFromText());
    leads.push(...this.extractFromSchema());
    leads.push(...this.extractFromStructuredData());
    
    // Filter by keywords if provided
    if (keywords.length > 0) {
      return this.filterByKeywords(leads, keywords);
    }
    
    // Remove empty leads
    return leads.filter(lead => 
      lead.name || lead.email || lead.phone || lead.company
    );
  }

  // Extract from mailto: and tel: links
  static extractFromContactLinks() {
    const leads = [];
    
    // Email links
    const emailLinks = document.querySelectorAll('a[href^="mailto:"]');
    emailLinks.forEach(link => {
      const email = link.href.replace('mailto:', '').split('?')[0];
      const text = link.textContent.trim();
      
      if (this.isValidEmail(email)) {
        leads.push({
          email,
          name: text && text !== email ? text : '',
          phone: '',
          company: '',
          jobTitle: '',
          website: '',
          address: ''
        });
      }
    });

    // Phone links
    const phoneLinks = document.querySelectorAll('a[href^="tel:"]');
    phoneLinks.forEach(link => {
      const phone = link.href.replace('tel:', '').replace(/-/g, '');
      const text = link.textContent.trim();
      
      if (this.isValidPhone(phone)) {
        // Check if lead with phone already exists
        const existingLead = leads.find(l => l.phone === phone);
        if (existingLead && text && text !== phone) {
          existingLead.name = existingLead.name || text;
        } else if (!existingLead) {
          leads.push({
            name: text && text !== phone ? text : '',
            email: '',
            phone,
            company: '',
            jobTitle: '',
            website: '',
            address: ''
          });
        }
      }
    });

    return leads;
  }

  // Extract from plain text on page
  static extractFromText() {
    const leads = [];
    const text = document.body.innerText;
    
    // Find emails
    const emails = text.match(this.EMAIL_REGEX) || [];
    emails.forEach(email => {
      leads.push({
        email: email.toLowerCase(),
        name: '',
        phone: '',
        company: '',
        jobTitle: '',
        website: '',
        address: ''
      });
    });

    // Find phone numbers
    const phones = text.match(this.PHONE_REGEX) || [];
    phones.forEach(phone => {
      // Check if this phone is already in leads
      const cleanPhone = phone.replace(/\D/g, '');
      const existingLead = leads.find(l => 
        l.phone && l.phone.replace(/\D/g, '') === cleanPhone
      );
      
      if (!existingLead) {
        leads.push({
          name: '',
          email: '',
          phone,
          company: '',
          jobTitle: '',
          website: '',
          address: ''
        });
      }
    });

    // Try to extract company and job title from headings
    this.NAME_SELECTORS.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 2 && text.length < 100) {
          // Check if this is near contact info
          const parent = el.closest('article, li, div[class*="card"], div[class*="profile"]');
          if (parent) {
            const parentText = parent.innerText;
            const hasEmail = parentText.match(this.EMAIL_REGEX);
            const hasPhone = parentText.match(this.PHONE_REGEX);
            
            if (hasEmail || hasPhone) {
              // Find associated lead
              const emailMatch = hasEmail ? hasEmail[0] : null;
              const phoneMatch = hasPhone ? hasPhone[0] : null;
              
              if (emailMatch) {
                const lead = leads.find(l => l.email === emailMatch.toLowerCase());
                if (lead && !lead.name) {
                  lead.name = text;
                }
              }
              
              if (phoneMatch) {
                const lead = leads.find(l => l.phone === phoneMatch);
                if (lead && !lead.name) {
                  lead.name = text;
                }
              }
            }
          }
        }
      });
    });

    // Extract company names
    this.COMPANY_SELECTORS.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 2 && text.length < 100 && !text.includes('@')) {
          const parent = el.closest('article, li, div[class*="card"], div[class*="profile"]');
          if (parent) {
            const parentText = parent.innerText;
            const emailMatch = parentText.match(this.EMAIL_REGEX);
            
            if (emailMatch) {
              const lead = leads.find(l => l.email === emailMatch[0].toLowerCase());
              if (lead && !lead.company) {
                lead.company = text;
              }
            }
          }
        }
      });
    });

    // Extract job titles
    this.JOB_TITLE_SELECTORS.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 2 && text.length < 100) {
          const parent = el.closest('article, li, div[class*="card"], div[class*="profile"]');
          if (parent) {
            const parentText = parent.innerText;
            const emailMatch = parentText.match(this.EMAIL_REGEX);
            
            if (emailMatch) {
              const lead = leads.find(l => l.email === emailMatch[0].toLowerCase());
              if (lead && !lead.jobTitle) {
                lead.jobTitle = text;
              }
            }
          }
        }
      });
    });

    return leads;
  }

  // Extract from Schema.org markup
  static extractFromSchema() {
    const leads = [];
    
    // Person schema
    const personScripts = document.querySelectorAll('script[type="application/ld+json"]');
    personScripts.forEach(script => {
      try {
        const data = JSON.parse(script.textContent);
        const persons = Array.isArray(data) ? data : [data];
        
        persons.forEach(item => {
          if (item['@type'] === 'Person' || item['@type'] === 'Organization') {
            const lead = {
              name: item.name || '',
              email: item.email || '',
              phone: item.telephone || '',
              company: item.jobTitle ? '' : (item.name || ''),
              jobTitle: item.jobTitle || '',
              website: item.url || '',
              address: item.address?.streetAddress || ''
            };
            
            // Only add if has some data
            if (lead.name || lead.email || lead.phone) {
              leads.push(lead);
            }
          }
        });
      } catch (e) {
        // Invalid JSON, skip
      }
    });

    return leads;
  }

  // Extract from structured HTML (microformats)
  static extractFromStructuredData() {
    const leads = [];
    
    // vCard format
    const vcards = document.querySelectorAll('.vcard, [class*="vcard"]');
    vcards.forEach(vcard => {
      const name = vcard.querySelector('.fn, .full-name, [class*="name"]')?.textContent?.trim();
      const email = vcard.querySelector('.email, [class*="email"]')?.textContent?.trim();
      const phone = vcard.querySelector('.tel, [class*="phone"]')?.textContent?.trim();
      const org = vcard.querySelector('.org, .organization-name')?.textContent?.trim();
      const title = vcard.querySelector('.title, .job-title')?.textContent?.trim();
      
      if (name || email || phone) {
        leads.push({
          name: name || '',
          email: email || '',
          phone: phone || '',
          company: org || '',
          jobTitle: title || '',
          website: '',
          address: ''
        });
      }
    });

    // hCard format
    const hcards = document.querySelectorAll('.hcard, [class*="h-card"]');
    hcards.forEach(hcard => {
      const name = hcard.querySelector('.p-name, .u-name')?.textContent?.trim();
      const email = hcard.querySelector('.u-email')?.textContent?.trim();
      const phone = hcard.querySelector('.p-tel')?.textContent?.trim();
      const org = hcard.querySelector('.p-org')?.textContent?.trim();
      const title = hcard.querySelector('.p-job-title')?.textContent?.trim();
      
      if (name || email || phone) {
        leads.push({
          name: name || '',
          email: email || '',
          phone: phone || '',
          company: org || '',
          jobTitle: title || '',
          website: '',
          address: ''
        });
      }
    });

    return leads;
  }

  // Filter leads by keywords
  static filterByKeywords(leads, keywords) {
    return leads.filter(lead => {
      const searchText = [
        lead.name, lead.email, lead.company, lead.jobTitle, lead.phone
      ].filter(Boolean).join(' ').toLowerCase();
      
      return keywords.some(keyword => searchText.includes(keyword.toLowerCase()));
    });
  }

  // Validate email
  static isValidEmail(email) {
    return this.EMAIL_REGEX.test(email);
  }

  // Validate phone
  static isValidPhone(phone) {
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length >= 10 && cleaned.length <= 15;
  }

  // Clean and normalize extracted data
  static normalize(lead) {
    return {
      name: lead.name?.trim() || '',
      email: lead.email?.toLowerCase().trim() || '',
      phone: lead.phone?.trim() || '',
      company: lead.company?.trim() || '',
      jobTitle: lead.jobTitle?.trim() || '',
      website: lead.website?.trim() || '',
      address: lead.address?.trim() || ''
    };
  }
}