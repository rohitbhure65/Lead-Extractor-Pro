// Lead Extractor Pro - Background Service Worker
// Handles extraction tasks and communication

let popupWindowId = null;

chrome.action.onClicked.addListener(async () => {
  await openPersistentPopupWindow();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractFromUrl') {
    extractFromUrl(message.url, message.keywords)
      .then(leads => sendResponse({ leads }))
      .catch(error => sendResponse({ error: error.message, leads: [] }));
  } else if (message.action === 'openWhatsAppAndSend') {
    openWhatsAppAndSend(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: error.message || 'Failed to open WhatsApp' }));
  }
  
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' || !tab.active || !tab.url || tab.url.startsWith('chrome-extension://')) {
    return;
  }

  clearLeadDatabase()
    .then(() => chrome.runtime.sendMessage({ action: 'leadsCleared', reason: 'page-refresh', tabId }).catch(() => {}))
    .catch((error) => console.error('Failed to clear leads on refresh:', error));
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

async function openPersistentPopupWindow() {
  const popupUrl = chrome.runtime.getURL('popup/popup.html');

  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch (error) {
      popupWindowId = null;
    }
  }

  const createdWindow = await chrome.windows.create({
    url: popupUrl,
    type: 'popup',
    focused: true,
    width: 820,
    height: 720
  });

  popupWindowId = createdWindow.id ?? null;
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

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
