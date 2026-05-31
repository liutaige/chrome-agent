// ============================================================================
// Three-Layer Storage Model
//
// Layer 1 — chrome.storage.session (temporary, memory-backed):
//   - Active ReAct loop execution state
//   - Active port IDs
//   - Temporary UI state
//   - Decrypted API keys (runtime only)
//   Lifecycle: Browser session
//
// Layer 2 — chrome.storage.local + unlimitedStorage (persistent):
//   - Full conversation history
//   - Completed loop summaries
//   - User preferences
//   - Encrypted API keys
//   - Page snapshot cache
//   Lifecycle: Cross-session persistent (with eviction policy)
//
// Layer 3 — chrome.storage.sync (optional, cross-device):
//   - Cross-device conversation sync (future)
//   Lifecycle: Cross-device
// ============================================================================

// ─── Key Namespaces ────────────────────────────────────────────────────────

/** Namespace keys by tabId for session isolation. */
function tabKey(tabId: number, suffix: string): string {
  return `tab:${tabId}:${suffix}`;
}

// Session storage keys
export const SESSION_KEYS = {
  reactState: (tabId: number) => tabKey(tabId, 'react_state'),
  activePortId: (tabId: number) => tabKey(tabId, 'port_id'),
  uiState: (tabId: number) => tabKey(tabId, 'ui_state'),
  decryptedKeys: 'session:decrypted_keys',
} as const;

// Local storage keys
export const LOCAL_KEYS = {
  conversationHistory: (tabId: number) => tabKey(tabId, 'conversation'),
  loopSummary: (tabId: number) => tabKey(tabId, 'loop_summary'),
  userPreferences: 'user:preferences',
  encryptionSalt: 'encryption:salt',
  wrappedDek: 'encryption:wrapped_dek',
  apiKeyDeepseek: 'encryption:deepseek_api_key',
  apiKeyDoubao: 'encryption:doubao_api_key',
  pageSnapshotCache: (tabId: number) => tabKey(tabId, 'snapshot_cache'),
  activeSessions: 'sessions:active',
  domainAuthList: 'screenshots:domain_auth',
  domainBlockList: 'screenshots:domain_block',
} as const;

// ─── Conversation Types ────────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCallRecord[];
  timestamp: number;
  tokenCount?: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  timestamp: number;
}

export interface ConversationHistory {
  tabId: number;
  messages: ConversationMessage[];
  totalTokens: number;
  createdAt: number;
  updatedAt: number;
  summaryAt?: number; // token index where summary was injected
}

// ─── ReAct State ───────────────────────────────────────────────────────────

export interface ReactLoopState {
  tabId: number;
  stepIndex: number;
  status: 'idle' | 'thinking' | 'executing' | 'waiting_user' | 'completed' | 'errored' | 'stopped';
  observationHistory: string[];
  operationHistory: OperationRecord[];
  tagLocatorMap: Map<number, LocatorRecord>;
  lastActivityTimestamp: number;
  abortControllerId?: string;
}

export interface OperationRecord {
  step: number;
  action: string;
  params: Record<string, unknown>;
  result: string;
  timestamp: number;
  preHash: string;
  postHash: string;
  retryCount: number;
}

export interface LocatorRecord {
  dataTagId: string;
  cssPath: string;
  attributeSelector: string;
  textFragment: string;
  ttlMs: number;
  createdAt: number;
  fingerprint: string;
}

// ─── User Preferences ──────────────────────────────────────────────────────

export interface UserPreferences {
  theme: 'light' | 'dark' | 'auto';
  language: 'zh' | 'en';
  maxConcurrentLoops: 1 | 2;
  defaultTimeoutMs: number;
  autoApproveScreenshots: boolean;
  domainBlockList: string[];
  sessionBudget: number | null; // null = no budget
}

const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'auto',
  language: 'zh',
  maxConcurrentLoops: 2,
  defaultTimeoutMs: 30000,
  autoApproveScreenshots: false,
  domainBlockList: [],
  sessionBudget: null,
};

// ─── Session Persistence ───────────────────────────────────────────────────

export interface ActiveSessionRecord {
  tabId: number;
  url: string;
  startedAt: number;
  lastActivityAt: number;
  loopStatus: ReactLoopState['status'];
}

// ─── Storage API ───────────────────────────────────────────────────────────

// ── Session Layer ──

export async function setReactState(tabId: number, state: ReactLoopState): Promise<void> {
  // Serialize Map for storage
  const serialized = {
    ...state,
    tagLocatorMap: Array.from(state.tagLocatorMap.entries()),
  };
  await chrome.storage.session.set({ [SESSION_KEYS.reactState(tabId)]: serialized });
}

export async function getReactState(tabId: number): Promise<ReactLoopState | null> {
  const data = await chrome.storage.session.get([SESSION_KEYS.reactState(tabId)]);
  const raw = data[SESSION_KEYS.reactState(tabId)] as Record<string, unknown> | undefined;
  if (!raw) return null;

  // Deserialize Map
  return {
    ...raw,
    tagLocatorMap: new Map(raw.tagLocatorMap as Iterable<[number, LocatorRecord]>),
  } as unknown as ReactLoopState;
}

export async function clearReactState(tabId: number): Promise<void> {
  await chrome.storage.session.remove([SESSION_KEYS.reactState(tabId)]);
}

export async function setActivePortId(tabId: number, portId: string): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEYS.activePortId(tabId)]: portId });
}

export async function getActivePortId(tabId: number): Promise<string | null> {
  const data = await chrome.storage.session.get([SESSION_KEYS.activePortId(tabId)]);
  return (data[SESSION_KEYS.activePortId(tabId)] as string) ?? null;
}

// ── Local Layer — Conversations ──

export async function saveConversation(history: ConversationHistory): Promise<void> {
  history.updatedAt = Date.now();
  await chrome.storage.local.set({ [LOCAL_KEYS.conversationHistory(history.tabId)]: history });
}

export async function loadConversation(tabId: number): Promise<ConversationHistory | null> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.conversationHistory(tabId)]);
  return (data[LOCAL_KEYS.conversationHistory(tabId)] as ConversationHistory) ?? null;
}

export async function deleteConversation(tabId: number): Promise<void> {
  await chrome.storage.local.remove([LOCAL_KEYS.conversationHistory(tabId)]);
}

export async function saveLoopSummary(tabId: number, summary: string): Promise<void> {
  await chrome.storage.local.set({
    [LOCAL_KEYS.loopSummary(tabId)]: { summary, timestamp: Date.now() },
  });
}

export async function getLoopSummary(tabId: number): Promise<string | null> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.loopSummary(tabId)]);
  const record = data[LOCAL_KEYS.loopSummary(tabId)] as { summary: string } | undefined;
  return record?.summary ?? null;
}

// ── Local Layer — Active Sessions ──

export async function registerActiveSession(session: ActiveSessionRecord): Promise<void> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.activeSessions]);
  const sessions: Record<string, ActiveSessionRecord> = data[LOCAL_KEYS.activeSessions] ?? {};
  sessions[String(session.tabId)] = session;
  await chrome.storage.local.set({ [LOCAL_KEYS.activeSessions]: sessions });
}

export async function unregisterActiveSession(tabId: number): Promise<void> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.activeSessions]);
  const sessions: Record<string, ActiveSessionRecord> = data[LOCAL_KEYS.activeSessions] ?? {};
  delete sessions[String(tabId)];
  await chrome.storage.local.set({ [LOCAL_KEYS.activeSessions]: sessions });
}

export async function getActiveSessions(): Promise<ActiveSessionRecord[]> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.activeSessions]);
  const sessions: Record<string, ActiveSessionRecord> = data[LOCAL_KEYS.activeSessions] ?? {};
  return Object.values(sessions);
}

/**
 * Check for in-progress sessions on Service Worker startup.
 * If any sessions were active when the SW was killed, offer recovery.
 */
export async function findInProgressSessions(): Promise<ActiveSessionRecord[]> {
  const sessions = await getActiveSessions();
  return sessions.filter(
    (s) => s.loopStatus === 'thinking' || s.loopStatus === 'executing' || s.loopStatus === 'waiting_user',
  );
}

// ── Local Layer — Screenshot Authorization ──

export async function getDomainScreenshotAuth(domain: string): Promise<'session' | 'always' | 'never' | null> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.domainAuthList]);
  const authList: Record<string, 'session' | 'always' | 'never'> = data[LOCAL_KEYS.domainAuthList] ?? {};
  return authList[domain] ?? null;
}

export async function setDomainScreenshotAuth(
  domain: string,
  auth: 'session' | 'always' | 'never',
): Promise<void> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.domainAuthList]);
  const authList: Record<string, 'session' | 'always' | 'never'> = data[LOCAL_KEYS.domainAuthList] ?? {};
  authList[domain] = auth;
  await chrome.storage.local.set({ [LOCAL_KEYS.domainAuthList]: authList });
}

export async function getDomainBlockList(): Promise<string[]> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.domainBlockList]);
  return (data[LOCAL_KEYS.domainBlockList] as string[]) ?? [];
}

export async function setDomainBlockList(domains: string[]): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.domainBlockList]: domains });
}

// ── Local Layer — Page Snapshots ──

export async function cachePageSnapshot(tabId: number, snapshot: string): Promise<void> {
  await chrome.storage.local.set({
    [LOCAL_KEYS.pageSnapshotCache(tabId)]: { snapshot, timestamp: Date.now() },
  });
}

export async function getCachedPageSnapshot(tabId: number, maxAgeMs = 30000): Promise<string | null> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.pageSnapshotCache(tabId)]);
  const record = data[LOCAL_KEYS.pageSnapshotCache(tabId)] as { snapshot: string; timestamp: number } | undefined;
  if (!record) return null;
  if (Date.now() - record.timestamp > maxAgeMs) return null;
  return record.snapshot;
}

// ── Local Layer — User Preferences ──

export async function getUserPreferences(): Promise<UserPreferences> {
  const data = await chrome.storage.local.get([LOCAL_KEYS.userPreferences]);
  const stored = data[LOCAL_KEYS.userPreferences] as Partial<UserPreferences> | undefined;
  return { ...DEFAULT_PREFERENCES, ...stored };
}

export async function setUserPreferences(prefs: Partial<UserPreferences>): Promise<void> {
  const current = await getUserPreferences();
  const updated = { ...current, ...prefs };
  await chrome.storage.local.set({ [LOCAL_KEYS.userPreferences]: updated });
}

// ── Eviction ───────────────────────────────────────────────────────────────

const MAX_CONVERSATIONS = 20;
const MAX_CONVERSATION_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Evict old conversations and page snapshots.
 * Called on startup and periodically.
 */
export async function evictOldData(): Promise<void> {
  const allData = await chrome.storage.local.get(null);

  const conversationKeys = Object.keys(allData).filter((k) => k.match(/^tab:\d+:conversation$/));
  const snapshotKeys = Object.keys(allData).filter((k) => k.match(/^tab:\d+:snapshot_cache$/));

  const now = Date.now();

  // Sort conversations by updatedAt, keep only MAX_CONVERSATIONS
  const conversations = conversationKeys
    .map((key) => ({
      key,
      record: allData[key] as ConversationHistory,
    }))
    .filter((c) => c.record?.updatedAt)
    .sort((a, b) => b.record.updatedAt - a.record.updatedAt);

  const toRemove: string[] = [];

  // Remove old conversations
  for (const conv of conversations.slice(MAX_CONVERSATIONS)) {
    toRemove.push(conv.key);
  }

  // Remove expired conversations
  for (const conv of conversations) {
    if (now - conv.record.updatedAt > MAX_CONVERSATION_AGE_MS) {
      toRemove.push(conv.key);
    }
  }

  // Remove old snapshots (older than 1 hour — snapshots are temporary)
  for (const key of snapshotKeys) {
    const record = allData[key] as { timestamp: number } | undefined;
    if (record && now - record.timestamp > 60 * 60 * 1000) {
      toRemove.push(key);
    }
  }

  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove);
    console.log(`[storage] Evicted ${toRemove.length} stale entries.`);
  }
}

// ── Storage Health ─────────────────────────────────────────────────────────

/**
 * Get storage usage statistics.
 */
export async function getStorageStats(): Promise<{
  sessionBytes: number;
  localBytes: number;
  conversationCount: number;
}> {
  const sessionData = await chrome.storage.session.get(null);
  const localData = await chrome.storage.local.get(null);

  const sessionBytes = new TextEncoder().encode(JSON.stringify(sessionData)).length;
  const localBytes = new TextEncoder().encode(JSON.stringify(localData)).length;
  const conversationCount = Object.keys(localData).filter((k) => k.includes(':conversation')).length;

  return { sessionBytes, localBytes, conversationCount };
}
