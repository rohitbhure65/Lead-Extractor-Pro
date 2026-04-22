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

