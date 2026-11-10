const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBackgroundWithMocks() {
  const store = {};
  const alarmListeners = [];
  const installedListeners = [];
  const createdAlarms = {};
  const sentMessages = [];
  const tabMessages = [];

  let fetchHandler = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Unexpected fetch call' })
  });

  const chromeMock = {
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === 'string') {
            return key in store ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        set: async (obj) => {
          Object.assign(store, obj);
        },
        remove: async (key) => {
          if (Array.isArray(key)) {
            key.forEach((k) => delete store[k]);
          } else {
            delete store[key];
          }
        }
      }
    },
    alarms: {
      create: (name, info) => {
        createdAlarms[name] = info;
      },
      clear: async (name) => {
        delete createdAlarms[name];
      },
      onAlarm: {
        addListener: (fn) => alarmListeners.push(fn)
      }
    },
    tabs: {
      create: async ({ url }) => ({ id: 99, url }),
      sendMessage: async (tabId, msg) => {
        tabMessages.push({ tabId, msg });
        return { leads: [] };
      },
      remove: async () => {},
      onUpdated: {
        addListener: () => {},
        removeListener: () => {}
      }
    },
    runtime: {
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        return {};
      },
      onMessage: {
        addListener: () => {}
      },
      onInstalled: {
        addListener: (fn) => installedListeners.push(fn)
      }
    }
  };

  // Prevent real long-running timers from keeping Node alive
  const activeTimers = new Set();
  const safeSetInterval = (fn, ms) => {
    const id = setInterval(fn, ms);
    id.unref?.();
    activeTimers.add(id);
    return id;
  };
  const safeClearInterval = (id) => {
    clearInterval(id);
    activeTimers.delete(id);
  };
  const safeSetTimeout = (fn, ms) => {
    const id = setTimeout(fn, ms);
    id.unref?.();
    activeTimers.add(id);
    return id;
  };
  const safeClearTimeout = (id) => {
    clearTimeout(id);
    activeTimers.delete(id);
  };

  const sandbox = {
    chrome: chromeMock,
    console,
    Date,
    Math,
    Promise,
    Error,
    setTimeout: safeSetTimeout,
    clearTimeout: safeClearTimeout,
    setInterval: safeSetInterval,
    clearInterval: safeClearInterval,
    fetch: (...args) => fetchHandler(...args),
    importScripts: () => {}
  };

  vm.createContext(sandbox);
  const envCode = fs.readFileSync(path.join(__dirname, '..', 'env.js'), 'utf8');
  const bgCode = fs.readFileSync(path.join(__dirname, '..', 'background', 'background.js'), 'utf8');
  vm.runInContext(envCode, sandbox);
  vm.runInContext(bgCode, sandbox);

  return {
    sandbox,
    store,
    createdAlarms,
    sentMessages,
    tabMessages,
    alarmListeners,
    setFetchMock(fn) {
      fetchHandler = fn;
    },
    cleanup() {
      sandbox.stopHeartbeat?.();
      for (const id of activeTimers) {
        clearTimeout(id);
        clearInterval(id);
      }
    }
  };
}

test('Scenario 1: Active Paid License validates and stores state + alarm', async () => {
  const ctx = loadBackgroundWithMocks();
  try {
    ctx.setFetchMock(async (url) => {
      assert.match(url, /\/api\/verify-key$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          valid: true,
          accessType: 'paid',
          email: 'paid@example.com',
          durationDays: 90,
          expiresAt: '2099-01-01T00:00:00.000Z'
        })
      };
    });

    const result = await ctx.sandbox.validateLicense('valid-key-here');
    assert.equal(result.valid, true);
    assert.equal(result.accessType, 'paid');
    assert.equal(ctx.store.licenseState.valid, true);
    assert.equal(ctx.store.licenseState.sessionToken, 'valid-key-here');
    assert.ok(ctx.createdAlarms.mapLeadifyLicenseCheck);
  } finally {
    ctx.cleanup();
  }
});

test('Scenario 2: Expired Paid License throws on validateLicense & preserves token on verifyLicenseNow', async () => {
  const ctx = loadBackgroundWithMocks();
  try {
    ctx.store.licenseState = {
      valid: true,
      sessionToken: 'expired-key-here',
      accessType: 'paid',
      expiresAt: '2020-01-01T00:00:00.000Z'
    };

    ctx.setFetchMock(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        valid: false,
        code: 'SUBSCRIPTION_EXPIRED',
        accessType: 'paid',
        expired: true,
        expiresAt: '2020-01-01T00:00:00.000Z',
        error: 'Subscription has expired'
      })
    }));

    await assert.rejects(
      () => ctx.sandbox.validateLicense('expired-key-here'),
      /expired/i
    );

    const verifyRes = await ctx.sandbox.verifyLicenseNow({ broadcastOnFailure: true });
    assert.equal(verifyRes.valid, false);
    assert.equal(verifyRes.status, 'expired');
    assert.equal(verifyRes.expired, true);
    // Token preserved so Renew & Refresh Access work smoothly
    assert.equal(ctx.store.licenseState.sessionToken, 'expired-key-here');
    assert.equal(ctx.store.licenseState.valid, false);
    assert.ok(ctx.sentMessages.some((m) => m.action === 'accessRevoked'));
    assert.ok(ctx.sentMessages.some((m) => m.action === 'sessionUpdate' && m.session.licenseRevoked === true));
  } finally {
    ctx.cleanup();
  }
});

test('Scenario 3: Deleted/Non-existent License clears stored key via message handler', async () => {
  const ctx = loadBackgroundWithMocks();
  try {
    ctx.store.licenseState = { valid: true, sessionToken: 'deleted-key-here' };
    ctx.setFetchMock(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ valid: false, code: 'INVALID_KEY', error: 'Invalid API Key' })
    }));

    const resp = await new Promise((resolve) => {
      ctx.sandbox.handleBackgroundMessage(
        { action: 'validateLicense', apiKey: 'deleted-key-here' },
        null,
        resolve
      );
    });

    assert.equal(resp.valid, false);
    assert.equal(resp.status, 'deleted');
    assert.equal(ctx.store.licenseState, undefined);
  } finally {
    ctx.cleanup();
  }
});

test('Scenario 4: Unused Trial Key activates only on explicit action, never during background check', async () => {
  const ctx = loadBackgroundWithMocks();
  try {
    let activateCalls = 0;
    ctx.setFetchMock(async (url, opts) => {
      if (url.endsWith('/api/verify-key')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            valid: false,
            code: 'TRIAL_NOT_ACTIVATED',
            accessType: 'trial',
            canActivate: true,
            durationDays: 7,
            error: 'Trial account has not been activated yet.'
          })
        };
      }
      if (url.endsWith('/api/trial/activate')) {
        activateCalls += 1;
        const body = JSON.parse(opts.body);
        assert.equal(body.trialKey, 'MLT-TRIAL123');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            valid: true,
            accessType: 'trial',
            email: 'trial@example.com',
            durationDays: 7,
            startDate: '2026-11-10T00:00:00.000Z',
            expiresAt: '2026-11-17T00:00:00.000Z'
          })
        };
      }
      throw new Error('Unexpected url: ' + url);
    });

    // Passive verification must NOT activate unused trial
    ctx.store.licenseState = { valid: false, sessionToken: 'MLT-TRIAL123', accessType: 'trial' };
    const passiveRes = await ctx.sandbox.verifyLicenseNow({ broadcastOnFailure: false });
    assert.equal(passiveRes.valid, false);
    assert.equal(passiveRes.status, 'trial_not_activated');
    assert.equal(activateCalls, 0);

    // Explicit UI validateLicense({ activateIfUnusedTrial: true }) activates one-time trial
    const activeRes = await ctx.sandbox.validateLicense('MLT-TRIAL123', { activateIfUnusedTrial: true });
    assert.equal(activeRes.valid, true);
    assert.equal(activeRes.accessType, 'trial');
    assert.equal(activateCalls, 1);
    assert.equal(ctx.store.licenseState.valid, true);
    assert.equal(ctx.store.licenseState.accessType, 'trial');
  } finally {
    ctx.cleanup();
  }
});

test('Scenario 5: Trial User Purchases Subscription (Scenario C) seamlessly upgrades on verification + halts extraction on expiry', async () => {
  const ctx = loadBackgroundWithMocks();
  try {
    // User starts with Trial key while active trial
    ctx.store.licenseState = {
      valid: true,
      sessionToken: 'MLT-UPGRADE1',
      accessType: 'trial',
      expiresAt: '2099-01-01T00:00:00.000Z'
    };

    // Backend reports upgraded paid access even for the trial key
    ctx.setFetchMock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        valid: true,
        accessType: 'paid',
        upgradedFromTrial: true,
        email: 'clientc@example.com',
        durationDays: 30,
        expiresAt: '2099-02-01T00:00:00.000Z'
      })
    }));

    const upgraded = await ctx.sandbox.verifyLicenseNow();
    assert.equal(upgraded.valid, true);
    assert.equal(ctx.store.licenseState.accessType, 'paid');
    assert.equal(ctx.store.licenseState.upgradedFromTrial, true);

    // Start an extraction session
    const started = await new Promise((resolve) => {
      ctx.sandbox.handleBackgroundMessage(
        { action: 'extractionStarted', sessionId: 'sess_1', tabId: 42 },
        null,
        resolve
      );
    });
    assert.equal(started.ok, true);

    // Now simulate subscription/trial expiring while extension stays open
    ctx.setFetchMock(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        valid: false,
        code: 'SUBSCRIPTION_EXPIRED',
        accessType: 'paid',
        expired: true,
        error: 'Subscription has expired'
      })
    }));

    // Trigger alarm callback
    await ctx.sandbox.verifyLicenseNow({ broadcastOnFailure: true });
    assert.equal(ctx.store.licenseState.valid, false);
    assert.equal(ctx.store.licenseState.expired, true);
    assert.ok(ctx.tabMessages.some((m) => m.tabId === 42 && m.msg.action === 'stopExtraction'));
    assert.equal(ctx.store.extractionSession.isExtracting, false);
  } finally {
    ctx.cleanup();
  }
});
