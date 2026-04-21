// Lead Extractor Pro - Background Service Worker
// Handles extraction tasks and communication

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractFromUrl') {
    extractFromUrl(message.url, message.keywords)
      .then(leads => sendResponse({ leads }))
      .catch(error => sendResponse({ error: error.message, leads: [] }));
  } else if (message.action === 'openWhatsAppAndSend') {
    openWhatsAppAndSend(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message || 'Failed to open WhatsApp' }));
  } else if (message.action === 'saveLeadRequest') {
    // Relay saveLeadRequest from content script to popup
    chrome.runtime.sendMessage({
      action: 'saveLeadRequest',
      lead: message.lead
    }).catch(console.error);
    sendResponse({ relayed: true });
  }

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' || !tab.active || !tab.url || tab.url.startsWith('chrome-extension://')) {
    return;
  }

  // FIXED: Don't clear leads on Google Maps pages or refreshes - persist across navigation
  if (tab.url.includes('/maps')) {
    console.log('[PERSISTENCE] Skipping lead clear on Maps page:', tab.url);
    return;
  }

  // Clear only on non-Maps page navigation (user intent to start fresh)
  clearLeadDatabase()
    .then(() => chrome.runtime.sendMessage({ action: 'leadsCleared', reason: 'page-change', tabId }).catch(() => { }))
    .catch((error) => console.error('Failed to clear leads on page change:', error));
});

// Extract leads from a specific URL
async function extractFromUrl(url, keywords = []) {
  try {
    const tab = await chrome.tabs.create({ url, active: false });

    // Wait for page to load
    await new Promise(resolve => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      });
    });

    // Send extraction message to content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'extract',
      keywords,
      source: url
    });

    // Close the tab
    await chrome.tabs.remove(tab.id);

    return response?.leads || [];
  } catch (error) {
    console.error('URL extraction error:', error);
    return [];
  }
}

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Lead Extractor Pro installed');
  }
});

function clearLeadDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('LeadExtractorDB', 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('leads')) {
        db.createObjectStore('leads', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('leads')) {
        db.close();
        resolve();
        return;
      }

      const transaction = db.transaction(['leads'], 'readwrite');
      const store = transaction.objectStore('leads');
      const clearRequest = store.clear();

      clearRequest.onerror = () => reject(clearRequest.error);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

async function openWhatsAppAndSend(url) {
  if (!url) {
    throw new Error('WhatsApp URL is missing');
  }

  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabComplete(tab.id);

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'autoSendWhatsApp' });
  } catch (error) {
    throw new Error('WhatsApp opened, but auto-send could not be completed');
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1200);
      }
    });
  });
}

