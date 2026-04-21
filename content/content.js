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

  if (message.action === 'saveLeadRequest') {
    const lead = extractCurrentPageLead();
    if (lead) {
      chrome.runtime.sendMessage({
        action: 'saveLeadRequest',
        lead: lead
      });
      sendResponse({ ready: true });
    } else {
      sendResponse({ error: 'No lead data found on page' });
    }
    return true;
  }
  return false;
});

function extractCurrentPageLead() {
  // Try Google Maps selected place first
  if (isGoogleMapsPage()) {
    const placeLead = extractSelectedGoogleMapsPlace();
    if (placeLead && placeLead.name) {
      placeLead.source = 'Google Maps - Selected Place';
      return placeLead;
    }
  }

  // Standard page extraction (top lead)
  const leads = extractStandardLeads([], {});
  if (leads.length > 0) {
    leads[0].source = document.title.slice(0, 100);
    return leads[0];
  }

  return null;
}

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

// FIXED: More lenient filter for Google Maps business listings
// Accept ANY business card with basic identification data
function matchesLeadRequirements(lead, options = {}) {
  const requirePhone = options.requirePhone || false;

  // FIXED: Very relaxed criteria - accept ANY listing with any data
  const hasAnyData =
    lead.name ||
    lead.company ||
    lead.address ||
    lead.category ||
    lead.rating ||
    lead.status ||
    lead.phone ||
    lead.website;

  if (!hasAnyData) {
    console.log('[FILTER] ❌ Rejected completely empty lead:', lead);
    return false;
  }

  // Only require phone if explicitly requested
  if (requirePhone && !lead.phone) {
    console.log('[FILTER] ❌ Rejected no-phone lead (requirePhone=true):', { name: lead.name, company: lead.company });
    return false;
  }

  console.log('[FILTER] ✅ Accepted listing:', {
    name: lead.name?.slice(0, 30),
    company: lead.company?.slice(0, 30),
    category: lead.category?.slice(0, 30),
    hasPhone: !!lead.phone,
    hasRating: !!lead.rating
  });
  return true;
}

async function extractGoogleMapsLeads({ keywords = [], sessionId, options = {} }) {
  const maxLeads = options.noLimit ? null : parsePositiveInt(options.maxLeads);
  const seen = new Set();
  const bufferedLeads = [];

  // Wait for page to be fully loaded
  await waitForGoogleMapsReady();

  let scrollContainer = findGoogleMapsScrollContainer();

  if (!scrollContainer) {
    throw new Error('Google Maps results panel not found');
  }

  console.log('[EXTRACT] Starting full auto-scroll to load all data...');

  // Enhanced auto-scroll with proper detection
  await enhancedAutoScroll(scrollContainer, {
    maxAttempts: 1000,
    scrollDelay: 5000,
    debug: true
  });

  let stagnantRounds = 0;
  let previousLeadCount = 0;
  let previousLastCardKey = '';

  while (!extractionState.stopRequested) {
    scrollContainer = findGoogleMapsScrollContainer() || scrollContainer;

    // Load more results if available
    await loadMoreGoogleMapsResults(scrollContainer);

    // FIXED: Define extractGoogleMapsVisibleLeads (was missing)
    const batch = (() => {
      const cards = getGoogleMapsResultCards();
      console.log(`[EXTRACT] Processing ${cards.length} cards`);

      const extracted = cards.map((card, index) => {
        const lead = extractGoogleMapsCardLead(card);
        if (lead) {
          console.log(`[EXTRACT] Card ${index}:`, lead);
        }
        return lead;
      }).filter(Boolean);

      console.log(`[EXTRACT] Raw extracted: ${extracted.length} leads`);

      const filtered = extracted
        .filter(lead => !seen.has(buildLeadKey(lead)))
        .filter(lead => matchesLeadRequirements(lead, options))
        .filter((lead, index, self) => {
          const key = buildLeadKey(lead);
          if (seen.has(key)) return false;
          seen.add(key);
          return maxLeads ? self.length < maxLeads : true;
        });

      console.log(`[EXTRACT] Filtered/unique: ${filtered.length} leads (seen: ${seen.size})`);
      return filtered;
    })();

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

    const noNewLeads = bufferedLeads.length === previousLeadCount;
    const sameLastCard = Boolean(lastCardKey) && lastCardKey === previousLastCardKey;
    const reachedEnd = hasReachedGoogleMapsResultsEnd(scrollContainer);

    if (noNewLeads && sameLastCard && reachedEnd) {
      stagnantRounds += 1;
    } else {
      stagnantRounds = 0;
    }

    previousLeadCount = bufferedLeads.length;
    previousLastCardKey = lastCardKey;

    if (stagnantRounds >= 3) {
      console.log('[EXTRACT] No new leads found, stopping extraction');
      break;
    }

    await wait(1500);
  }

  const stopped = extractionState.stopRequested;

  // IMPROVED: Better final message
  let finalStatus = stopped ? `Stopped.` : `Completed.`;
  if (bufferedLeads.length === 0) {
    finalStatus += ' No valid business listings found matching criteria';
    console.log('[FINAL] No leads extracted. Check console for filter logs.');
  } else {
    finalStatus += ` ${bufferedLeads.length} business leads ready!`;
  }

  await reportExtractionProgress({
    sessionId,
    leads: [],
    savedCount: bufferedLeads.length,
    statusText: finalStatus,
    percent: 100,
    complete: true
  });

  return {
    leads: bufferedLeads,
    savedCount: bufferedLeads.length,
    stopped
  };
}

// NEW: Enhanced auto-scroll function with proper detection
async function enhancedAutoScroll(container, options = {}) {
  const {
    maxAttempts = 1000,
    scrollDelay = 5000,
    debug = true
  } = options;

  let previousCardCount = 0;
  let previousScrollHeight = 0;
  let noChangeCount = 0;
  let consecutiveNoCards = 0;

  const log = debug ? (...args) => console.log('[AUTO-SCROLL]', ...args) : () => { };

  log('Starting enhanced auto-scroll');
  log(`Initial card count: ${getGoogleMapsResultCards().length}`);

  for (let attempt = 0; attempt < maxAttempts && !extractionState.stopRequested; attempt++) {
    const beforeCards = getGoogleMapsResultCards().length;
    const beforeScrollHeight = container.scrollHeight;

    log(`Attempt ${attempt + 1}/${maxAttempts} - Cards: ${beforeCards}, ScrollHeight: ${beforeScrollHeight}`);

    // Scroll to bottom
    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth'
    });

    // Trigger scroll events
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    window.dispatchEvent(new Event('scroll'));

    await wait(scrollDelay);

    const afterCards = getGoogleMapsResultCards().length;
    const afterScrollHeight = container.scrollHeight;

    log(`After scroll - Cards: ${afterCards}, ScrollHeight: ${afterScrollHeight}`);

    // Check for end of results
    if (hasReachedGoogleMapsResultsEnd(container)) {
      log('Reached end of results');
      break;
    }

    // Check if we're stuck
    if (afterCards === beforeCards) {
      noChangeCount++;
      log(`No new cards loaded (${noChangeCount}/5)`);

      if (noChangeCount >= 5) {
        // Try scrolling with different behavior
        log('Attempting aggressive scroll');
        container.scrollTop = container.scrollHeight;
        await wait(1000);

        // Try clicking "More results" button if exists
        const moreButton = findMoreResultsButton();
        if (moreButton) {
          log('Found "More results" button, clicking');
          moreButton.click();
          await wait(2000);
        }

        if (getGoogleMapsResultCards().length === afterCards) {
          log('Still no new cards, stopping scroll');
          break;
        }

        noChangeCount = 0;
      }
    } else {
      noChangeCount = 0;
      log(`Loaded ${afterCards - beforeCards} new cards!`);
    }

    // Check for empty results
    if (afterCards === 0) {
      consecutiveNoCards++;
      if (consecutiveNoCards >= 3) {
        log('No cards found after multiple attempts');
        break;
      }
    } else {
      consecutiveNoCards = 0;
    }

    previousCardCount = afterCards;
    previousScrollHeight = afterScrollHeight;

    // Small delay between attempts
    await wait(500);
  }

  log(`Auto-scroll complete. Final card count: ${getGoogleMapsResultCards().length}`);
}

// NEW: Find "More results" button
function findMoreResultsButton() {
  const selectors = [
    'button[aria-label="More results"]',
    'button:contains("More results")',
    'div[role="button"]:contains("More results")',
    'button[jsaction*="moreResults"]'
  ];

  for (const selector of selectors) {
    const button = document.querySelector(selector);
    if (button && button.offsetParent !== null) {
      return button;
    }
  }

  // Find by text content
  const buttons = document.querySelectorAll('button, div[role="button"]');
  for (const button of buttons) {
    if (button.textContent.toLowerCase().includes('more results')) {
      return button;
    }
  }

  return null;
}

// NEW: Wait for Google Maps to be ready
async function waitForGoogleMapsReady() {
  const maxAttempts = 30;
  const delay = 500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Try multiple container selectors for Google Maps
    const containerSelectors = [
      '.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd.QjC7t[role="feed"]',
      '.m6QErb[role="feed"]',
      '[role="feed"]',
      '.DxyBCb',
      '.m6QErb'
    ];

    let container = null;
    for (const selector of containerSelectors) {
      container = document.querySelector(selector);
      if (container) break;
    }

    const cards = getGoogleMapsResultCards();

    console.log(`[MAPS READY] Attempt ${attempt + 1}: Container found: ${!!container}, Cards: ${cards.length}`);

    if (container || cards.length > 0) {
      console.log('[MAPS READY] Maps ready - Container found:', !!container, 'Cards:', cards.length);
      return true;
    }

    await wait(delay);
  }

  console.warn('[MAPS READY] Timeout waiting for Maps - proceeding anyway');
  // Don't fail - proceed and try to extract anyway
  return true;
}

// ENHANCED: Extract more data from Google Maps card
function extractGoogleMapsCardLead(card) {
  const rawText = card.innerText || '';
  const text = normalizeWhitespace(rawText);

  // If there's any text in the card, try to extract data
  if (!text) {
    console.log('[EXTRACT] Empty card, skipping');
    return null;
  }

  const lines = rawText
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line && !/^(photos|reviews|directions|save|nearby|send to your phone)$/i.test(line));

  // Extract name with better selectors
  const name = pickText(card, [
    '.qBF1Pd',
    '.fontHeadlineSmall',
    '.fontBodyMedium > div:first-child',
    '[role="heading"]',
    '.lMbq3e',
    'div[role="article"] div:first-child',
    'a.hfpxzc[aria-label]'
  ]) || lines[0] || '';

  // Extract rating and review count
  const ratingMatch = text.match(/(\d\.\d)\s*★?/);
  const reviewsMatch = text.match(/\(([\d,]+)\)/);

  // Extract phone with better regex
  // IMPROVED: Better international phone regex for India/etc.
  const phoneMatch = text.match(/(\+?\d[\s\-\(\)\.]?)?\(?(\d{3})\)?[\s\-\(\)\.]?(\d{3})[\s\-\(\)\.]?(\d{4})/) ||
    text.match(/(\+91[\s\-]?)?\d{10}/) ||
    text.match(/(?:\+?\d[\d\s().-]{7,}\d)/);

  // Extract website
  const website = card.querySelector('a[href^="http"]:not([href*="google.com"])')?.href || '';

  // Extract address with better detection
  const addressLine = lines.find((line) =>
    /road|rd\b|street|st\b|floor|scheme|park|nagar|indore|near|colony|sector|tower|hotel|marg|block|avenue|area|drive|lane|boulevard|plaza|square|court|way|circle/i.test(line)
  ) || '';

  // Extract category/business type
  const categoryLine = lines.find((line) =>
    line !== name &&
    !line.includes('★') &&
    !line.includes('(') &&
    !/open|closed/i.test(line) &&
    !/(reserve a table|order online|website|directions|call)/i.test(line)
  ) || '';

  // Extract hours/status
  const statusMatch = text.match(/(Open|Closed|Opens at|Closes at)\s*(?:⋅)?\s*([^★\n]+)/i);
  const status = statusMatch ? statusMatch[0].trim() : '';

  // Extract price range (if available)
  const priceMatch = text.match(/[$]{1,4}/);
  const priceRange = priceMatch ? priceMatch[0] : '';

  // Extract additional info like "In-store pickup", "Delivery", etc.
  const services = [];
  const serviceKeywords = ['delivery', 'pickup', 'dine-in', 'takeout', 'reservation', 'curbside'];
  serviceKeywords.forEach(service => {
    if (text.toLowerCase().includes(service)) {
      services.push(service);
    }
  });

  const lead = normalizeLead({
    name,
    company: name,
    phone: phoneMatch ? phoneMatch[0].trim() : '',
    website,
    address: addressLine,
    category: categoryLine,
    rating: ratingMatch ? ratingMatch[1] : '',
    reviews: reviewsMatch ? reviewsMatch[1].replace(/,/g, '') : '',
    status,
    priceRange,
    services: services.join(', '),
    rawData: text.substring(0, 500) // Store raw data for debugging
  });

  // FIXED: Accept leads with ANY data (name is most important)
  if (!lead.name && !lead.phone && !lead.website) {
    console.log('[EXTRACT] Rejecting card with no name/phone/website:', text.slice(0, 100));
    return null;
  }

  console.log('[EXTRACT] Extracted lead:', { name: lead.name?.slice(0, 30), phone: lead.phone ? 'yes' : 'no' });
  return lead;
}

// ENHANCED: Get all result cards with better selection
function getGoogleMapsResultCards() {
  const selectorList = [
    '.Nv2PK', // Primary selector
    '.Nv2PK.THOPZb',
    '.THOPZb',
    'a.hfpxzc',  // Links to places
    '[role="feed"] [role="article"]',
    '[role="feed"] > div > div',
    '.m6QErb [role="article"]',
    '.m6QErb .Nv2PK',
    'div[aria-label][data-result]',
    // New selectors for current Google Maps
    '.place-result',
    '.search-results .result'
  ];

  const cards = [];
  const seen = new Set();

  selectorList.forEach((selector) => {
    try {
      document.querySelectorAll(selector).forEach((node) => {
        // Try to find the closest card container
        const card = node.closest('[role="article"]') ||
          node.closest('.Nv2PK') ||
          node.closest('.THOPZb') ||
          node.closest('[role="feed"] > div') ||
          node;

        const text = normalizeWhitespace(card.innerText || '');
        if (!text || text.length < 3) {
          return;
        }

        const key = `${card.className || card.tagName}|${text.slice(0, 120)}`;
        if (!seen.has(key)) {
          seen.add(key);
          cards.push(card);
        }
      });
    } catch (e) {
      // Ignore invalid selectors
    }
  });

  // Sort cards by their vertical position (top to bottom)
  const sortedCards = [...new Map(cards.map(card => [card, card])).values()]
    .sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      return rectA.top - rectB.top;
    });

  console.log('[CARDS] Found', sortedCards.length, 'result cards');
  return sortedCards;
}

// ENHANCED: Check if reached end of results
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
    'no results found',
    'no more places'
  ];

  if (endMarkers.some((marker) => text.includes(marker))) {
    return true;
  }

  // Check if we're at the bottom and no more loading indicators
  const nearBottom = container.scrollHeight - (container.scrollTop + container.clientHeight) < 50;
  const loadingIndicator = container.querySelector('[aria-label*="loading"], [role="progressbar"]');

  if (nearBottom && !loadingIndicator) {
    // Try one more small scroll
    const beforeScrollHeight = container.scrollHeight;
    container.scrollTop = container.scrollHeight;

    // Check if we can scroll further
    if (container.scrollHeight === beforeScrollHeight && container.scrollTop + container.clientHeight >= container.scrollHeight - 10) {
      return true;
    }
  }

  const cards = getGoogleMapsResultCards();
  const noCards = cards.length === 0;

  return noCards ? nearBottom : false;
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

  // Extract hours for selected place
  const hoursMatch = text.match(/(Open|Closed|Opens at|Closes at)\s*(?:⋅)?\s*([^★\n]+)/i);
  const hours = hoursMatch ? hoursMatch[0].trim() : '';

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
    reviews: reviewsMatch ? reviewsMatch[1] : '',
    hours
  });
}

function findGoogleMapsScrollContainer() {
  // Enhanced container selectors for current Google Maps
  const selectors = [
    // Primary feed container (most common)
    '.m6QErb.DxyBCb.kA9KIf.dS8AEf.XiKgde.ecceSd.QjC7t[role="feed"]',
    '.m6QErb[role="feed"]',
    '[role="feed"]',
    // Alternative containers
    'div.m6QErb.WNBkOb.XiKgde[role="main"]',
    '.m6QErb[role="main"]',
    '.DxyBCb[role="feed"]',
    // Fallback to any scrollable results container
    '.DxyBCb',
    '.m6QErb'
  ];

  for (const selector of selectors) {
    const container = document.querySelector(selector);
    if (container && isScrollableContainer(container)) {
      console.log('[SCROLL] Found container:', selector);
      return container;
    }
  }

  // Fallback: find any scrollable container with cards
  const cards = getGoogleMapsResultCards();
  const candidates = new Set();

  cards.slice(0, 5).forEach((card) => {
    let node = card?.parentElement;
    let depth = 0;
    while (node && depth < 10) {
      if (isScrollableContainer(node)) {
        candidates.add(node);
      }
      node = node.parentElement;
      depth += 1;
    }
  });

  const container = Array.from(candidates)
    .filter((el) => isScrollableContainer(el))
    .filter((el) => el.querySelector('.Nv2PK, [role="article"]'))
    .sort((a, b) => scoreScrollContainer(b) - scoreScrollContainer(a))[0];

  if (container) {
    console.log('[SCROLL] Fallback container found:', container.className);
  }

  return container || document.body; // Never return null - use body as last resort
}

async function loadMoreGoogleMapsResults(container) {
  if (!container) return { hasNewCards: false, reachedEnd: true };

  const beforeCards = getGoogleMapsResultCards().length;

  // Smooth scroll to bottom
  container.scrollTo({
    top: container.scrollHeight,
    behavior: 'smooth'
  });

  await wait(2000);

  const afterCards = getGoogleMapsResultCards().length;
  const hasNew = afterCards > beforeCards;
  const reachedEnd = hasReachedGoogleMapsResultsEnd(container);

  console.log('[LOAD-MORE] Cards:', beforeCards, '→', afterCards, 'New:', hasNew, 'End:', reachedEnd);
  return { hasNewCards: hasNew, reachedEnd };
}

function isScrollableContainer(el) {
  if (!el) {
    return false;
  }

  const style = window.getComputedStyle(el);
  const hasScroll = style.overflowY === 'auto' || style.overflowY === 'scroll';
  const canScroll = el.scrollHeight > el.clientHeight + 5;

  return hasScroll && canScroll;
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
  const timeoutMs = 3500;
  const pollMs = 250;
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
    address: lead.address?.trim() || '',
    status: lead.status?.trim() || '',
    priceRange: lead.priceRange?.trim() || '',
    services: lead.services?.trim() || '',
    hours: lead.hours?.trim() || ''
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
