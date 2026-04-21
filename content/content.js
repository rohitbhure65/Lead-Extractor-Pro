// Lead Extractor Pro - Content Script
// Injected into pages for lead extraction

const extractionState = {
  sessionId: null,
  isRunning: false,
  stopRequested: false
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extract') {
    handleExtractionRequest(message)
      .then(sendResponse)
      .catch((error) => {
        console.error('Extraction error:', error);
        sendResponse({ error: error.message, leads: [] });
      });

    return true;
  }

  if (message.action === 'stopExtraction') {
    if (!message.sessionId || message.sessionId === extractionState.sessionId) {
      extractionState.stopRequested = true;
    }

    sendResponse({ stopped: true });
    return false;
  }

  if (message.action === 'autoSendWhatsApp') {
    autoSendWhatsAppMessage()
      .then(() => sendResponse({ sent: true }))
      .catch((error) => sendResponse({ error: error.message }));

    return true;
  }

  return false;
});

async function autoSendWhatsAppMessage() {
  if (!/(\.|^)whatsapp\.com$/i.test(window.location.hostname) && !/wa\.me$/i.test(window.location.hostname)) {
    throw new Error('Not on a WhatsApp page');
  }

  const timeoutMs = 15000;
  const pollMs = 500;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const sendButton = findWhatsAppSendButton();
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      return;
    }

    await wait(pollMs);
  }

  throw new Error('Send button not ready');
}

function findWhatsAppSendButton() {
  const selectors = [
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button[data-testid="compose-btn-send"]',
    'button[data-testid="send"]',
    'span[data-icon="send"]'
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) {
      continue;
    }

    if (el.tagName === 'BUTTON') {
      return el;
    }

    const button = el.closest('button');
    if (button) {
      return button;
    }
  }

  return null;
}

async function handleExtractionRequest(message) {
  const sessionId = message.sessionId || `session_${Date.now()}`;
  extractionState.sessionId = sessionId;
  extractionState.isRunning = true;
  extractionState.stopRequested = false;
  const options = message.options || {};

  try {
    if (isGoogleMapsPage()) {
      return await extractGoogleMapsLeads({
        keywords: message.keywords || [],
        sessionId,
        options
      });
    }

    const leads = extractStandardLeads(message.keywords || [], options).map((lead) => ({
      ...lead
    }));

    return { leads, savedCount: leads.length, stopped: false };
  } finally {
    extractionState.isRunning = false;
    extractionState.stopRequested = false;
    extractionState.sessionId = null;
  }
}

function extractStandardLeads(keywords = [], options = {}) {
  const leads = [];

  leads.push(...extractFromContactLinks());
  leads.push(...extractFromTextContent());
  leads.push(...extractFromSchema());
  leads.push(...extractFromMicroformats());

  const filteredLeads = keywords.length > 0
    ? filterByKeywords(leads, keywords)
    : leads;

  return filteredLeads
    .map(normalizeLead)
    .filter((lead) => matchesLeadRequirements(lead, options))
    .filter((lead) => lead.name || lead.phone || lead.company || lead.website || lead.address);
}

async function extractGoogleMapsLeads({ keywords = [], sessionId, options = {} }) {
  const maxLeads = options.noLimit ? null : parsePositiveInt(options.maxLeads);
  const seen = new Set();
  const bufferedLeads = [];
  let scrollContainer = findGoogleMapsScrollContainer();

  if (!scrollContainer) {
    throw new Error('Google Maps results panel not found');
  }

  let stagnantRounds = 0;
  let previousLeadCount = 0;
  let previousLastCardKey = '';

  while (!extractionState.stopRequested) {
    scrollContainer = findGoogleMapsScrollContainer() || scrollContainer;
    const batch = extractGoogleMapsVisibleLeads({ keywords, seen, maxLeads, options });
    const visibleCards = getGoogleMapsResultCards();
    const lastCardKey = buildCardSnapshotKey(visibleCards[visibleCards.length - 1]);

    if (batch.length > 0) {
      bufferedLeads.push(...batch);
      await reportExtractionProgress({
        sessionId,
        leads: batch,
        savedCount: bufferedLeads.length,
        statusText: `Saved ${bufferedLeads.length} leads...`,
        percent: maxLeads ? Math.round((bufferedLeads.length / maxLeads) * 100) : approximatePercent(stagnantRounds, false)
      });
    } else {
      await reportExtractionProgress({
        sessionId,
        leads: [],
        savedCount: bufferedLeads.length,
        statusText: `Scanning... ${bufferedLeads.length} leads found`,
        percent: maxLeads ? Math.round((bufferedLeads.length / maxLeads) * 100) : approximatePercent(stagnantRounds, false)
      });
    }

    if (maxLeads && bufferedLeads.length >= maxLeads) {
      break;
    }

    if (hasReachedGoogleMapsResultsEnd(scrollContainer)) {
      break;
    }

    const loadState = await loadMoreGoogleMapsResults(scrollContainer, {
      previousCardCount: visibleCards.length,
      previousLastCardKey: lastCardKey
    });

    scrollContainer = findGoogleMapsScrollContainer() || scrollContainer;
    const noNewLeads = bufferedLeads.length === previousLeadCount;
    const sameLastCard = Boolean(lastCardKey) && lastCardKey === previousLastCardKey;
    const noNewCards = !loadState.hasNewCards;
    const reachedEnd = loadState.reachedEnd || hasReachedGoogleMapsResultsEnd(scrollContainer);

    if (noNewLeads && sameLastCard && noNewCards && reachedEnd) {
      stagnantRounds += 1;
    } else {
      stagnantRounds = 0;
    }

    previousLeadCount = bufferedLeads.length;
    previousLastCardKey = lastCardKey;

    if (stagnantRounds >= 5) {
      break;
    }
  }

  const stopped = extractionState.stopRequested;
  await reportExtractionProgress({
    sessionId,
    leads: [],
    savedCount: bufferedLeads.length,
    statusText: stopped
      ? `Stopped. ${bufferedLeads.length} leads ready`
      : `Completed. ${bufferedLeads.length} leads ready`,
    percent: 100,
    complete: true
  });

  return {
    leads: [],
    savedCount: bufferedLeads.length,
    stopped
  };
}

function extractGoogleMapsVisibleLeads({ keywords, seen, maxLeads, options = {} }) {
  const cards = getGoogleMapsResultCards();

  const results = [];

  for (const card of cards) {
    if (maxLeads && seen.size >= maxLeads) {
      break;
    }

    const lead = extractGoogleMapsCardLead(card);
    if (!lead) {
      continue;
    }

    if (!matchesLeadRequirements(lead, options)) {
      continue;
    }

    if (keywords.length > 0 && !matchesKeywords(lead, keywords)) {
      continue;
    }

    const key = buildLeadKey(lead);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(lead);
  }

  const selectedPlace = extractSelectedGoogleMapsPlace();
  if (selectedPlace && (!maxLeads || seen.size < maxLeads)) {
    if (matchesLeadRequirements(selectedPlace, options) && (!keywords.length || matchesKeywords(selectedPlace, keywords))) {
      const selectedKey = buildLeadKey(selectedPlace);
      if (selectedKey && !seen.has(selectedKey)) {
        seen.add(selectedKey);
        results.unshift(selectedPlace);
      }
    }
  }

  return results;
}

function matchesLeadRequirements(lead, options = {}) {
  if (options.requirePhone && !lead.phone) {
    return false;
  }

  return true;
}

function extractGoogleMapsCardLead(card) {
  const rawText = card.innerText || '';
  const text = normalizeWhitespace(rawText);
  if (!text) {
    return null;
  }

  const lines = rawText
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line && !/^(photos|reviews|directions|save|nearby|send to your phone)$/i.test(line));
  const name = pickText(card, ['.qBF1Pd', '.fontHeadlineSmall', '.fontBodyMedium > div:first-child']) || lines[0] || '';

  const ratingMatch = text.match(/(\d\.\d)\s*★?/);
  const reviewsMatch = text.match(/\(([\d,]+)\)/);
  const phoneMatch = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/);
  const website = card.querySelector('a[href^="http"]:not([href*="google.com"])')?.href || '';

  const addressLine = lines.find((line) => /road|rd\b|street|st\b|floor|scheme|park|nagar|indore|near|colony|sector|tower|hotel|marg|block|avenue|area/i.test(line)) || '';
  const categoryLine = lines.find((line) =>
    line !== name &&
    !line.includes('★') &&
    !line.includes('(') &&
    !/open|closed/i.test(line) &&
    !/(reserve a table|order online|website|directions|call)/i.test(line)
  ) || '';

  const lead = normalizeLead({
    name,
    company: name,
    phone: phoneMatch ? phoneMatch[0].trim() : '',
    website,
    address: addressLine,
    category: categoryLine,
    rating: ratingMatch ? ratingMatch[1] : '',
    reviews: reviewsMatch ? reviewsMatch[1] : ''
  });

  return lead.name || lead.phone || lead.website ? lead : null;
}

function getGoogleMapsResultCards() {
  const selectorList = [
    '[role="feed"] [role="article"]',
    '.Nv2PK',
    '.Nv2PK.THOPZb',
    '.THOPZb',
    'a.hfpxzc',
    'div[aria-label] > a[href*="/maps/place/"]'
  ];

  const cards = [];
  const seen = new Set();

  selectorList.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      const card = node.closest('[role="article"], .Nv2PK, .THOPZb') || node;
      const text = normalizeWhitespace(card.innerText || '');
      if (!text) {
        return;
      }

      const key = `${card.className || card.tagName}|${text.slice(0, 120)}`;
      if (!seen.has(key)) {
        seen.add(key);
        cards.push(card);
      }
    });
  });

  return cards;
}

function extractSelectedGoogleMapsPlace() {
  const panel = document.querySelector('div[role="main"]') || document;
  const name = pickText(panel, ['h1.DUwDvf', 'h1.fontHeadlineLarge', 'h1']);
  const website =
    panel.querySelector('a[data-item-id="authority"]')?.href ||
    panel.querySelector('a[aria-label*="Website"]')?.href ||
    '';
  const address = pickDataItemText(panel, ['address']) || pickLabelValue(panel, ['address']);
  const phone = pickDataItemText(panel, ['phone']) || pickLabelValue(panel, ['phone', 'call']);
  const text = normalizeWhitespace(panel.innerText || '');
  const ratingMatch = text.match(/(\d\.\d)\s*★?/);
  const reviewsMatch = text.match(/\(([\d,]+)\)/);

  if (!name && !phone && !website && !address) {
    return null;
  }

  return normalizeLead({
    name,
    company: name,
    phone,
    website,
    address,
    rating: ratingMatch ? ratingMatch[1] : '',
    reviews: reviewsMatch ? reviewsMatch[1] : ''
  });
}

function findGoogleMapsScrollContainer() {
  const cards = getGoogleMapsResultCards();
  const candidates = new Set(document.querySelectorAll('div[role="feed"], div[aria-label][tabindex="-1"], div.m6QErb[aria-label]'));

  cards.slice(0, 5).forEach((card) => {
    let node = card?.parentElement;
    let depth = 0;

    while (node && depth < 6) {
      if (isScrollableContainer(node)) {
        candidates.add(node);
      }

      node = node.parentElement;
      depth += 1;
    }
  });

  return Array.from(candidates)
    .filter((el) => isScrollableContainer(el))
    .filter((el) => containsResultCards(el) || isLikelyLeftSidebar(el))
    .sort((a, b) => scoreScrollContainer(b) - scoreScrollContainer(a))[0] || null;
}

function scrollGoogleMapsResults(container) {
  const increment = Math.max(container.clientHeight * 0.85, 600);
  container.scrollBy({ top: increment, behavior: 'auto' });
}

async function loadMoreGoogleMapsResults(container, previousState = {}) {
  if (!container) {
    return { hasNewCards: false, reachedEnd: true };
  }

  const beforeTop = container.scrollTop || 0;
  const beforeHeight = container.scrollHeight || 0;
  const cards = getGoogleMapsResultCards();
  const lastCard = cards[cards.length - 1] || null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const targetTop = Math.max(container.scrollHeight, beforeTop + container.clientHeight);
    container.scrollTo({ top: targetTop, behavior: 'auto' });
    scrollGoogleMapsResults(container);

    if (lastCard) {
      const cardTop = lastCard.offsetTop || 0;
      const cardHeight = lastCard.offsetHeight || 0;
      const lastCardTarget = Math.max(cardTop - container.clientHeight + cardHeight + 160, container.scrollTop);
      container.scrollTo({ top: lastCardTarget, behavior: 'auto' });
    }

    container.dispatchEvent(new Event('scroll', { bubbles: true }));

    const changed = await waitForGoogleMapsResultsChange(container, previousState);
    if (changed.hasNewCards || changed.reachedEnd) {
      return changed;
    }
  }

  const afterCards = getGoogleMapsResultCards();
  const afterLastCardKey = buildCardSnapshotKey(afterCards[afterCards.length - 1]);
  const afterTop = container.scrollTop || 0;
  const afterHeight = container.scrollHeight || 0;

  return {
    hasNewCards:
      afterCards.length > (previousState.previousCardCount || 0) ||
      (afterLastCardKey && afterLastCardKey !== previousState.previousLastCardKey) ||
      afterHeight > beforeHeight ||
      afterTop > beforeTop,
    reachedEnd: hasReachedGoogleMapsResultsEnd(container)
  };
}

function isScrollableContainer(el) {
  if (!el) {
    return false;
  }

  const style = window.getComputedStyle(el);
  return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
}

function scoreScrollContainer(el) {
  const rect = el.getBoundingClientRect();
  const cardCount = el.querySelectorAll('[role="article"], .Nv2PK, .THOPZb').length;
  const leftSidebarBonus = isLikelyLeftSidebar(el) ? 5000 : 0;
  const feedBonus = el.getAttribute('role') === 'feed' ? 1500 : 0;
  const visibleHeightBonus = Math.max(0, rect.height);
  const widthPenalty = rect.width > window.innerWidth * 0.6 ? 2000 : 0;

  return leftSidebarBonus + feedBonus + visibleHeightBonus + (el.scrollHeight - el.clientHeight) + (cardCount * 200) - widthPenalty;
}

function buildCardSnapshotKey(card) {
  if (!card) {
    return '';
  }

  return normalizeWhitespace(card.innerText || '').slice(0, 160);
}

async function waitForGoogleMapsResultsChange(container, previousState = {}) {
  const timeoutMs = 2200;
  const pollMs = 200;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (hasReachedGoogleMapsResultsEnd(container)) {
      return { hasNewCards: false, reachedEnd: true };
    }

    const cards = getGoogleMapsResultCards();
    const lastCardKey = buildCardSnapshotKey(cards[cards.length - 1]);

    if (
      cards.length > (previousState.previousCardCount || 0) ||
      (lastCardKey && lastCardKey !== previousState.previousLastCardKey)
    ) {
      return { hasNewCards: true, reachedEnd: false };
    }

    await wait(pollMs);
  }

  return { hasNewCards: false, reachedEnd: hasReachedGoogleMapsResultsEnd(container) };
}

function hasReachedGoogleMapsResultsEnd(container) {
  if (!container) {
    return true;
  }

  const text = normalizeWhitespace(container.innerText || '').toLowerCase();
  const endMarkers = [
    "you've reached the end of the list",
    'you reached the end of the list',
    'end of results',
    'no more results',
    'no results found'
  ];

  if (endMarkers.some((marker) => text.includes(marker))) {
    return true;
  }

  const nearBottom = container.scrollHeight - (container.scrollTop + container.clientHeight) < 24;
  const cards = getGoogleMapsResultCards();
  const noCards = cards.length === 0;

  return noCards ? nearBottom : false;
}

function containsResultCards(el) {
  return el.querySelectorAll('[role="article"], .Nv2PK, .THOPZb').length > 0;
}

function isLikelyLeftSidebar(el) {
  const rect = el.getBoundingClientRect();

  if (!rect.width || !rect.height) {
    return false;
  }

  const startsOnLeftSide = rect.left < window.innerWidth * 0.35;
  const notTooWide = rect.width < window.innerWidth * 0.5;
  const tallEnough = rect.height > window.innerHeight * 0.3;

  return startsOnLeftSide && notTooWide && tallEnough;
}

async function reportExtractionProgress(payload) {
  try {
    await chrome.runtime.sendMessage({
      action: 'extractionProgress',
      ...payload
    });
  } catch (error) {
    // Ignore when popup is closed or not listening.
  }
}

function approximatePercent(stagnantRounds, complete) {
  if (complete) {
    return 100;
  }

  return Math.min(95, 20 + stagnantRounds * 15);
}

function parsePositiveInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLeadKey(lead) {
  const phone = lead.phone?.replace(/\D/g, '') || '';
  const website = lead.website?.toLowerCase() || '';
  const name = lead.name?.toLowerCase() || '';
  const address = lead.address?.toLowerCase() || '';
  const key = [name, phone, website, address].join('|');
  return key === '|||' ? '' : key;
}

function matchesKeywords(lead, keywords) {
  const searchText = [
    lead.name,
    lead.company,
    lead.category,
    lead.status,
    lead.services,
    lead.address,
    lead.phone,
    lead.website
  ].filter(Boolean).join(' ').toLowerCase();

  return keywords.some((keyword) => searchText.includes(keyword.toLowerCase()));
}

function extractFromContactLinks() {
  const leads = [];

  document.querySelectorAll('a[href^="mailto:"]').forEach((link) => {
    const email = link.href.replace('mailto:', '').split('?')[0].trim();
    const text = link.textContent.trim();

    if (isValidEmail(email)) {
      leads.push({
        email: email.toLowerCase(),
        name: text && text !== email ? text : '',
        phone: ''
      });
    }
  });

  document.querySelectorAll('a[href^="tel:"]').forEach((link) => {
    const phone = link.href.replace('tel:', '').replace(/-/g, '').trim();
    const text = link.textContent.trim();

    if (isValidPhone(phone)) {
      const existing = leads.find((lead) => lead.phone === phone);
      if (existing && text && text !== phone) {
        existing.name = existing.name || text;
      } else if (!existing) {
        leads.push({
          name: text && text !== phone ? text : '',
          email: '',
          phone
        });
      }
    }
  });

  return leads;
}

function extractFromTextContent() {
  const leads = [];
  const text = document.body.innerText;

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = text.match(emailRegex) || [];

  emails.forEach((email) => {
    leads.push({
      email: email.toLowerCase(),
      name: '',
      phone: ''
    });
  });

  const phoneRegex = /(?:\+?1?[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const phones = text.match(phoneRegex) || [];

  phones.forEach((phone) => {
    const cleanPhone = phone.replace(/\D/g, '');
    const existing = leads.find((lead) => lead.phone && lead.phone.replace(/\D/g, '') === cleanPhone);

    if (!existing) {
      leads.push({
        name: '',
        email: '',
        phone
      });
    }
  });

  extractStructuredInfo(leads);

  return leads;
}

function extractStructuredInfo(leads) {
  const nameSelectors = ['h1', 'h2', 'h3', '[itemprop="name"]', '.name', '.author', '.profile-name'];
  const companySelectors = ['[itemprop="name"]', '.company', '.organization'];
  const titleSelectors = ['[itemprop="jobTitle"]', '.job-title', '.title', '.position'];

  leads.forEach((lead) => {
    if (lead.email) {
      const emailSelector = `[href="mailto:${lead.email}"], [href*="mailto:${lead.email}"]`;
      const emailEl = document.querySelector(emailSelector) ||
        Array.from(document.querySelectorAll('a[href*="mailto:"]')).find((el) =>
          el.href.includes(lead.email)
        );

      if (emailEl) {
        const parent = emailEl.closest('article, li, div, section');
        if (parent) {
          nameSelectors.forEach((selector) => {
            if (!lead.name) {
              const el = parent.querySelector(selector);
              const text = el?.textContent?.trim();
              if (text && text.length < 50) {
                lead.name = text;
              }
            }
          });

          companySelectors.forEach((selector) => {
            if (!lead.company) {
              const el = parent.querySelector(selector);
              const text = el?.textContent?.trim();
              if (text && text.length < 100) {
                lead.company = text;
              }
            }
          });

          titleSelectors.forEach((selector) => {
            if (!lead.jobTitle) {
              const el = parent.querySelector(selector);
              const text = el?.textContent?.trim();
              if (text && text.length < 50) {
                lead.jobTitle = text;
              }
            }
          });
        }
      }
    }
  });
}

function extractFromSchema() {
  const leads = [];

  document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data) ? data : [data];

      items.forEach((item) => {
        if (item['@type'] === 'Person') {
          leads.push({
            name: item.name || '',
            email: item.email || '',
            phone: item.telephone || '',
            company: item.jobTitle ? '' : (item.name || ''),
            jobTitle: item.jobTitle || '',
            website: item.url || '',
            address: item.address?.streetAddress || ''
          });
        }
      });
    } catch (error) {
      // Ignore invalid JSON blocks.
    }
  });

  return leads;
}

function extractFromMicroformats() {
  const leads = [];

  document.querySelectorAll('.vcard, [class*="vcard"]').forEach((vcard) => {
    const name = vcard.querySelector('.fn')?.textContent?.trim();
    const email = vcard.querySelector('.email')?.textContent?.trim();
    const phone = vcard.querySelector('.tel')?.textContent?.trim();
    const org = vcard.querySelector('.org')?.textContent?.trim();
    const title = vcard.querySelector('.title')?.textContent?.trim();

    if (name || email || phone) {
      leads.push({
        name: name || '',
        email: email || '',
        phone: phone || '',
        company: org || '',
        jobTitle: title || ''
      });
    }
  });

  return leads;
}

function filterByKeywords(leads, keywords) {
  return leads.filter((lead) => matchesKeywords(lead, keywords));
}

function pickText(root, selectors) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const text = el?.textContent?.trim();
    if (text) {
      return text;
    }
  }

  return '';
}

function pickDataItemText(root, keys) {
  for (const key of keys) {
    const el = root.querySelector(`[data-item-id="${key}"], [data-item-id^="${key}:"]`);
    const text = extractActionText(el);
    if (text) {
      return text;
    }
  }

  return '';
}

function pickLabelValue(root, labels) {
  const elements = Array.from(root.querySelectorAll('button, a, div'));

  for (const el of elements) {
    const label = (el.getAttribute('aria-label') || '').trim();
    if (!label) {
      continue;
    }

    const lowerLabel = label.toLowerCase();
    const matches = labels.some((token) => lowerLabel.startsWith(token) || lowerLabel.includes(`${token}:`));
    if (!matches) {
      continue;
    }

    const value = label.split(':').slice(1).join(':').trim() || extractActionText(el);
    if (value && value.toLowerCase() !== label.toLowerCase()) {
      return value;
    }
  }

  return '';
}

function extractActionText(el) {
  if (!el) {
    return '';
  }

  const ariaLabel = (el.getAttribute('aria-label') || '').trim();
  if (ariaLabel.includes(':')) {
    const candidate = ariaLabel.split(':').slice(1).join(':').trim();
    if (candidate) {
      return candidate;
    }
  }

  return el.textContent?.trim() || '';
}

function normalizeLead(lead) {
  return {
    name: lead.name?.trim() || '',
    phone: lead.phone?.trim() || '',
    company: lead.company?.trim() || '',
    category: lead.category?.trim() || '',
    rating: lead.rating?.trim() || '',
    reviews: lead.reviews?.trim() || '',
    website: lead.website?.trim() || '',
    address: lead.address?.trim() || ''
  };
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function isGoogleMapsPage() {
  return /(^|\.)google\./i.test(window.location.hostname) && window.location.pathname.startsWith('/maps');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.length >= 10 && cleaned.length <= 15;
}
