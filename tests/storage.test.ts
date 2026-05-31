import { describe, it, expect, beforeEach } from 'vitest';
import {
  setReactState,
  getReactState,
  clearReactState,
  saveConversation,
  loadConversation,
  deleteConversation,
  registerActiveSession,
  unregisterActiveSession,
  getActiveSessions,
  findInProgressSessions,
  getUserPreferences,
  setUserPreferences,
  getDomainScreenshotAuth,
  setDomainScreenshotAuth,
  getDomainBlockList,
  setDomainBlockList,
  cachePageSnapshot,
  getCachedPageSnapshot,
  evictOldData,
  getStorageStats,
} from '../src/shared/storage';
import type { ReactLoopState, ConversationHistory, UserPreferences } from '../src/shared/storage';

beforeEach(async () => {
  await chrome.storage.session.clear();
  await chrome.storage.local.clear();
});

describe('Session Storage — ReAct State', () => {
  it('stores and retrieves ReAct loop state', async () => {
    const state: ReactLoopState = {
      tabId: 1,
      stepIndex: 3,
      status: 'thinking',
      observationHistory: ['Page loaded', 'Search box found'],
      operationHistory: [
        {
          step: 1,
          action: 'tag_elements',
          params: { selector: 'input' },
          result: 'Tagged 3 elements',
          timestamp: Date.now(),
          preHash: 'abc123',
          postHash: 'def456',
          retryCount: 0,
        },
      ],
      tagLocatorMap: new Map([
        [1, {
          dataTagId: '[data-tag-id="@1"]',
          cssPath: 'body > input:nth-child(1)',
          attributeSelector: 'input[type="text"][placeholder="Search"]',
          textFragment: 'input',
          ttlMs: 30000,
          createdAt: Date.now(),
          fingerprint: 'fp1',
        }],
      ]),
      lastActivityTimestamp: Date.now(),
    };

    await setReactState(1, state);

    const retrieved = await getReactState(1);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tabId).toBe(1);
    expect(retrieved!.stepIndex).toBe(3);
    expect(retrieved!.status).toBe('thinking');
    expect(retrieved!.tagLocatorMap.size).toBe(1);
    expect(retrieved!.tagLocatorMap.get(1)?.dataTagId).toBe('[data-tag-id="@1"]');
  });

  it('returns null for non-existent state', async () => {
    const result = await getReactState(999);
    expect(result).toBeNull();
  });

  it('clears ReAct state', async () => {
    const state: ReactLoopState = {
      tabId: 2,
      stepIndex: 0,
      status: 'idle',
      observationHistory: [],
      operationHistory: [],
      tagLocatorMap: new Map(),
      lastActivityTimestamp: Date.now(),
    };

    await setReactState(2, state);
    expect(await getReactState(2)).not.toBeNull();

    await clearReactState(2);
    expect(await getReactState(2)).toBeNull();
  });
});

describe('Local Storage — Conversations', () => {
  it('stores and retrieves conversation history', async () => {
    const history: ConversationHistory = {
      tabId: 5,
      messages: [
        { role: 'user', content: 'Search for iPhone', timestamp: Date.now() },
        { role: 'assistant', content: 'I found the search box', timestamp: Date.now() },
      ],
      totalTokens: 500,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await saveConversation(history);
    const loaded = await loadConversation(5);

    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.totalTokens).toBe(500);
  });

  it('returns null for non-existent conversation', async () => {
    const result = await loadConversation(999);
    expect(result).toBeNull();
  });

  it('deletes conversation', async () => {
    const history: ConversationHistory = {
      tabId: 3,
      messages: [],
      totalTokens: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await saveConversation(history);
    expect(await loadConversation(3)).not.toBeNull();

    await deleteConversation(3);
    expect(await loadConversation(3)).toBeNull();
  });
});

describe('Local Storage — Active Sessions', () => {
  it('registers and retrieves active sessions', async () => {
    await registerActiveSession({
      tabId: 1,
      url: 'https://example.com',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      loopStatus: 'thinking',
    });

    await registerActiveSession({
      tabId: 2,
      url: 'https://test.com',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      loopStatus: 'idle',
    });

    const sessions = await getActiveSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map(s => s.tabId).sort()).toEqual([1, 2]);
  });

  it('unregisters a session', async () => {
    await registerActiveSession({
      tabId: 1, url: 'https://example.com',
      startedAt: Date.now(), lastActivityAt: Date.now(), loopStatus: 'idle',
    });
    await unregisterActiveSession(1);
    expect(await getActiveSessions()).toHaveLength(0);
  });

  it('finds in-progress sessions', async () => {
    await registerActiveSession({
      tabId: 1, url: 'https://a.com', startedAt: Date.now(),
      lastActivityAt: Date.now(), loopStatus: 'executing',
    });
    await registerActiveSession({
      tabId: 2, url: 'https://b.com', startedAt: Date.now(),
      lastActivityAt: Date.now(), loopStatus: 'idle',
    });
    await registerActiveSession({
      tabId: 3, url: 'https://c.com', startedAt: Date.now(),
      lastActivityAt: Date.now(), loopStatus: 'waiting_user',
    });

    const inProgress = await findInProgressSessions();
    expect(inProgress).toHaveLength(2);
    expect(inProgress.map(s => s.tabId).sort()).toEqual([1, 3]);
  });
});

describe('Local Storage — Screenshot Authorization', () => {
  it('sets and gets domain auth', async () => {
    expect(await getDomainScreenshotAuth('example.com')).toBeNull();

    await setDomainScreenshotAuth('example.com', 'session');
    expect(await getDomainScreenshotAuth('example.com')).toBe('session');

    await setDomainScreenshotAuth('example.com', 'always');
    expect(await getDomainScreenshotAuth('example.com')).toBe('always');
  });

  it('sets and gets domain block list', async () => {
    const list = await getDomainBlockList();
    expect(list).toEqual([]);

    await setDomainBlockList(['bank.com', 'hospital.org']);
    expect(await getDomainBlockList()).toEqual(['bank.com', 'hospital.org']);
  });
});

describe('Local Storage — Page Snapshots', () => {
  it('caches and retrieves page snapshots', async () => {
    await cachePageSnapshot(1, 'snapshot data');

    const cached = await getCachedPageSnapshot(1, 60000);
    expect(cached).toBe('snapshot data');
  });

  it('returns null for expired snapshot', async () => {
    await cachePageSnapshot(1, 'old data');

    // Wait a tick so Date.now() difference > 0 ms
    await new Promise((r) => setTimeout(r, 5));

    // With maxAgeMs = 0, any age should exceed it
    const cached = await getCachedPageSnapshot(1, 0);
    expect(cached).toBeNull();
  });
});

describe('User Preferences', () => {
  it('returns defaults when not set', async () => {
    const prefs = await getUserPreferences();
    expect(prefs.theme).toBe('auto');
    expect(prefs.language).toBe('zh');
    expect(prefs.maxConcurrentLoops).toBe(2);
  });

  it('persists and retrieves preferences', async () => {
    await setUserPreferences({ theme: 'dark', language: 'en' });

    const prefs = await getUserPreferences();
    expect(prefs.theme).toBe('dark');
    expect(prefs.language).toBe('en');
    // Unchanged defaults should remain
    expect(prefs.maxConcurrentLoops).toBe(2);
  });
});

describe('Eviction', () => {
  it('evicts old conversations beyond max count', async () => {
    // Create 25 conversations (max is 20)
    for (let i = 0; i < 25; i++) {
      const history: ConversationHistory = {
        tabId: i,
        messages: [],
        totalTokens: 0,
        createdAt: Date.now() - (25 - i) * 3600000, // older first
        updatedAt: Date.now() - (25 - i) * 3600000,
      };
      await saveConversation(history);
    }

    await evictOldData();

    // Should have at most MAX_CONVERSATIONS (20)
    const stats = await getStorageStats();
    expect(stats.conversationCount).toBeLessThanOrEqual(20);
  });
});

describe('Storage Stats', () => {
  it('returns usage statistics', async () => {
    const stats = await getStorageStats();
    expect(stats).toHaveProperty('sessionBytes');
    expect(stats).toHaveProperty('localBytes');
    expect(stats).toHaveProperty('conversationCount');
    expect(typeof stats.sessionBytes).toBe('number');
    expect(typeof stats.localBytes).toBe('number');
  });
});
