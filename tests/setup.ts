// ============================================================================
// Test Setup — Global Mocks for Chrome Extension APIs
// Uses sinon-chrome to stub chrome.* APIs in jsdom environment.
// ============================================================================

import { vi, afterEach } from 'vitest';

// ─── chrome.runtime Mock ───────────────────────────────────────────────────

const mockRuntimeId = 'test-extension-id-abcdef';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = {
  runtime: {
    id: mockRuntimeId,
    getManifest: vi.fn(() => ({
      manifest_version: 3,
      name: 'Chrome Agent',
      version: '0.1.0',
    })),
    getURL: vi.fn((path: string) => `chrome-extension://${mockRuntimeId}/${path}`),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(() => false),
    },
    onConnect: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onInstalled: {
      addListener: vi.fn(),
    },
    sendMessage: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => ({
      name: 'test-port',
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      onDisconnect: {
        addListener: vi.fn(),
      },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    })),
    lastError: undefined,
    // openOptionsPage, reload, etc.
    openOptionsPage: vi.fn(),
    reload: vi.fn(),
  },

  // ─── chrome.storage Mock ─────────────────────────────────────────────────

  storage: {
    session: createStorageMock(),
    local: createStorageMock(),
    sync: createStorageMock(),
  },

  // ─── chrome.tabs Mock ────────────────────────────────────────────────────

  tabs: {
    query: vi.fn(() => Promise.resolve([{ id: 1, url: 'https://example.com' }])),
    get: vi.fn((tabId: number) =>
      Promise.resolve({ id: tabId, url: 'https://example.com', title: 'Test Page' }),
    ),
    sendMessage: vi.fn(() => Promise.resolve()),
    create: vi.fn(() => Promise.resolve({ id: 2 })),
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },

  // ─── chrome.scripting Mock ───────────────────────────────────────────────

  scripting: {
    executeScript: vi.fn(() => Promise.resolve([{ result: null }])),
    insertCSS: vi.fn(() => Promise.resolve()),
    removeCSS: vi.fn(() => Promise.resolve()),
  },

  // ─── chrome.webNavigation Mock ───────────────────────────────────────────

  webNavigation: {
    onBeforeNavigate: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onCommitted: {
      addListener: vi.fn(),
    },
  },

  // ─── chrome.sidePanel Mock ───────────────────────────────────────────────

  sidePanel: {
    open: vi.fn(() => Promise.resolve()),
    setOptions: vi.fn(() => Promise.resolve()),
    getOptions: vi.fn(() => Promise.resolve({})),
  },
};

// ─── Web Crypto API (available in Node 19+, but ensure it's polyfilled) ────

// crypto.subtle is already available in Node 19+ and jsdom with proper config.
// If not available, tests that use encryption will be skipped.

// ─── Helper: Create a mock storage area ────────────────────────────────────

function createStorageMock() {
  const store: Record<string, unknown> = {};

  return {
    get: vi.fn((keys?: string | string[] | Record<string, unknown> | null) => {
      if (keys === null || keys === undefined) {
        // Return all
        return Promise.resolve({ ...store });
      }
      if (typeof keys === 'string') {
        return Promise.resolve({ [keys]: store[keys] });
      }
      if (Array.isArray(keys)) {
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in store) {
            result[key] = store[key];
          }
        }
        return Promise.resolve(result);
      }
      // Object form: return defaults for missing keys
      const result: Record<string, unknown> = { ...keys };
      for (const key of Object.keys(keys)) {
        if (key in store) {
          result[key] = store[key];
        }
      }
      return Promise.resolve(result);
    }),

    set: vi.fn((items: Record<string, unknown>) => {
      Object.assign(store, items);
      return Promise.resolve();
    }),

    remove: vi.fn((keys: string | string[]) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        delete store[key];
      }
      return Promise.resolve();
    }),

    clear: vi.fn(() => {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
      return Promise.resolve();
    }),

    // For inspection in tests
    _dump: () => ({ ...store }),
  };
}

// ─── Reset between tests ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
afterEach(() => {
  vi.clearAllMocks();
  // Clear storage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionMock = (globalThis as any).chrome.storage.session;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const localMock = (globalThis as any).chrome.storage.local;
  sessionMock.clear();
  localMock.clear();
});
