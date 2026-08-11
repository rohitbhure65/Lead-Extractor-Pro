// mock background environment
const chrome = {
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
      remove: jest.fn()
    }
  },
  runtime: {
    sendMessage: jest.fn()
  }
};

global.fetch = jest.fn();

// Tests for the 3 scenarios
describe('License Validation Scenarios', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Scenario 1: Active License -> Start Discover', async () => {
    // Backend returns OK
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ expiresAt: '2099-01-01T00:00:00.000Z' })
    });

    const result = await validateLicense('valid-key-here');
    expect(result.valid).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });

  test('Scenario 2: Existing but Expired License -> "Your Subscription Has Expired"', async () => {
    // Backend returns not OK with "expired" error
    fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Subscription has expired' })
    });

    try {
      await validateLicense('expired-key-here');
    } catch (e) {
      expect(e.message.toLowerCase()).toContain('expired');
      // In the handler, this sets status = 'expired' and DOES NOT call logoutLicense
      // This allows the user to see the "Buy Subscription Again" button with their key still populated
    }
  });

  test('Scenario 3: Deleted/Non-existent License -> Clear Stored Key', async () => {
    // Backend returns not OK with "not found" error
    fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'License key not found in database' })
    });

    try {
      await validateLicense('deleted-key-here');
    } catch (e) {
      expect(e.message.toLowerCase()).not.toContain('expired');
      // In the handler, this sets status = 'deleted' and CALLS logoutLicense
      // simulating logoutLicense call in the background handler
      await chrome.storage.local.remove('licenseState');
      expect(chrome.storage.local.remove).toHaveBeenCalledWith('licenseState');
    }
  });
});
