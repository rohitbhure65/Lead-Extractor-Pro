// Lead Extractor Pro - Background Service Worker
// Handles extraction tasks and communication

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractFromUrl') {
    extractFromUrl(message.url, message.keywords)
      .then(leads => sendResponse({ leads }))
      .catch(error => sendResponse({ error: error.message, leads: [] }));
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