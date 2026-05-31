// ============================================================================
// Background Service Worker
//
// Core responsibilities:
//   1. Message validation & routing (security gateway)
//   2. API scheduling (DeepSeek + Doubao) with retry/circuit breaker
//   3. Screenshot capture with domain auth + DPR correction + crop
//   4. Navigation guard (documentId-based safe message sending)
//   5. Session isolation (per tabId)
//   6. Checkpoint/restore for Service Worker resilience
// ============================================================================

import { validateMessage } from '../shared/validation';
import { fetchWithRetry } from '../shared/retry';
import { loadApiKey, initializeEncryption } from '../shared/encryption';
import {
  registerActiveSession,
  unregisterActiveSession,
  findInProgressSessions,
  getDomainScreenshotAuth,
  setDomainScreenshotAuth,
} from '../shared/storage';
import type { ActionRequest } from '../shared/messages';

// ─── Constants ─────────────────────────────────────────────────────────────

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DOUBAO_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

const SEND_MESSAGE_TIMEOUT_MS = 5000;
const SCREENSHOT_QUALITY = 100; // PNG format (lossless)

// ─── Per-Tab State ─────────────────────────────────────────────────────────

interface TabSession {
  tabId: number;
  documentId: string;
  activeAbortController: AbortController | null;
  conversationHistory: ConversationTurn[];
  totalTokens: number;
  doubaoFailures: number;
  doubaoCircuitOpen: boolean;
  createdAt: number;
  lastActivityAt: number;
}

interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const sessions = new Map<number, TabSession>();

// ─── Initialization ────────────────────────────────────────────────────────

async function initialize(): Promise<void> {
  // Initialize encryption system
  await initializeEncryption();

  // Check for in-progress sessions from previous SW lifecycle
  const inProgress = await findInProgressSessions();
  if (inProgress.length > 0) {
    console.log(`[worker] Found ${inProgress.length} in-progress sessions from previous lifecycle`);
    for (const session of inProgress) {
      console.log(`[worker] Tab ${session.tabId} was at URL: ${session.url}`);
    }
  }

  // Set up listeners
  setupMessageListener();
  setupTabListeners();
  setupNavigationListener();
  setupSidePanelListener();

  console.log('[worker] Background Service Worker initialized.');
}

// ─── Message Listener (Security Gateway) ───────────────────────────────────

function setupMessageListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Security: validate sender and message structure
    const validation = validateMessage(message, sender);
    if (!validation.valid || !validation.message) {
      console.error('[worker] Message validation failed:', validation.error);
      sendResponse({ success: false, error: validation.error });
      return false;
    }

    const msg = validation.message;

    // Create or get session for this tab
    ensureSession(msg.tabId, sender);

    // Route the message
    handleAction(msg).then((result) => {
      try {
        sendResponse(result);
      } catch {
        // Response channel closed
      }
    });

    return true; // Keep channel open for async response
  });
}

// ─── Tab Lifecycle ─────────────────────────────────────────────────────────

function setupTabListeners(): void {
  // Clean up session when tab is closed
  chrome.tabs.onRemoved.addListener((tabId) => {
    const session = sessions.get(tabId);
    if (session) {
      session.activeAbortController?.abort();
      sessions.delete(tabId);
      unregisterActiveSession(tabId).catch(console.error);
      console.log(`[worker] Session for tab ${tabId} cleaned up.`);
    }
  });
}

// ─── Navigation Guard ──────────────────────────────────────────────────────

function setupNavigationListener(): void {
  // Track agent-initiated navigations by tabId + timestamp
  // When WE navigate, don't abort. When the USER navigates, abort.
  const agentNavTimestamps = new Map<number, number>();

  (globalThis as any).__markAgentNavigation = (tabId: number) => {
    agentNavTimestamps.set(tabId, Date.now());
  };

  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameType !== 'outermost_frame') return;

    // Check if this navigation was initiated by the agent (within the last 3 seconds)
    const agentNavTime = agentNavTimestamps.get(details.tabId);
    if (agentNavTime && Date.now() - agentNavTime < 3000) {
      agentNavTimestamps.delete(details.tabId);
      injectedTabs.delete(details.tabId);
      console.log(`[worker] Agent-initiated navigation to ${details.url}, continuing.`);
      return;
    }

    // User-initiated navigation — abort active operations
    const session = sessions.get(details.tabId);
    if (session) {
      session.activeAbortController?.abort();
      console.log(`[worker] User navigation detected, aborting operations in tab ${details.tabId}.`);
    }

    injectedTabs.delete(details.tabId);
  });
}

// ─── Side Panel — Port Connection ──────────────────────────────────────────

// Track connected Side Panel ports (one per window, usually one)
const sidePanelPorts = new Set<chrome.runtime.Port>();

function setupSidePanelListener(): void {
  // Set Side Panel options
  chrome.sidePanel?.setOptions?.({ enabled: true }).catch(() => {});
  // Click extension icon → open Side Panel directly
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

  // Listen for Side Panel port connections (long-lived bidirectional)
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sidepanel') return;

    sidePanelPorts.add(port);
    console.log('[worker] Side Panel connected');

    port.onMessage.addListener((msg: Record<string, unknown>) => {
      handleSidePanelMessage(port, msg);
    });

    port.onDisconnect.addListener(() => {
      sidePanelPorts.delete(port);
      console.log('[worker] Side Panel disconnected');
    });
  });
}

/** Broadcast a message to all connected Side Panels. */
function broadcastToSidePanel(msg: Record<string, unknown>): void {
  for (const port of sidePanelPorts) {
    try {
      port.postMessage(msg);
    } catch {
      sidePanelPorts.delete(port);
    }
  }
}

/** Handle messages coming FROM the Side Panel. */
function handleSidePanelMessage(
  port: chrome.runtime.Port,
  msg: Record<string, unknown>,
): void {
  const type = msg.type as string;
  const tabId = (msg.tabId ?? currentTabId) as number;

  switch (type) {
    case 'sidepanel_ready':
      // Side Panel just opened — check for recoverable session
      handleSidePanelReady(port, tabId);
      break;

    case 'user_task':
      // User submitted a new task
      handleUserTask(port, tabId, msg.text as string);
      break;

    case 'stop_task':
      // User clicked stop
      handleStopTask(tabId);
      break;

    case 'ask_user_response':
      // User answered an ask_user prompt
      handleAskUserResponse(tabId, msg.answer as string);
      break;
  }
}

// ─── Side Panel Message Handlers ───────────────────────────────────────────

/** Current active tab ID (set by Side Panel on ready). */
let currentTabId = 0;

/** Pending ask_user resolvers. */
const pendingAskUser = new Map<number, (answer: string) => void>();

/** Global stop flags per tab — checked by ReAct loop between steps. */
const stopFlags = new Map<number, boolean>();

async function handleSidePanelReady(_port: chrome.runtime.Port, tabId: number): Promise<void> {
  currentTabId = tabId;

  // Check for recoverable session
  const { checkRecoverableSession } = await import('./react-loop');
  const recovery = await checkRecoverableSession();

  if (recovery?.recoverable) {
    broadcastToSidePanel({
      type: 'step_status',
      stepId: 'recovery',
      status: 'waiting_user',
      detail: `检测到未完成的任务 (Tab ${recovery.tabId})，是否恢复？`,
    });
  }
}

async function handleUserTask(
  _port: chrome.runtime.Port,
  tabId: number,
  text: string,
): Promise<void> {
  if (!text?.trim()) return;

  // Check API keys
  const { hasApiKey, hasDoubaoEndpointId } = await import('../shared/encryption');
  const hasDeepSeek = await hasApiKey('deepseek');
  const hasDoubaoKey = await hasApiKey('doubao');
  const hasDoubaoEp = await hasDoubaoEndpointId();
  const hasDoubaoVision = hasDoubaoKey && hasDoubaoEp;

  if (!hasDeepSeek) {
    broadcastToSidePanel({
      type: 'step_status',
      stepId: 'error',
      status: 'errored',
      detail: '请先在设置页面配置 DeepSeek API Key',
    });
    return;
  }

  // Clear previous stop flag
  stopFlags.delete(tabId);

  // Create abort controller for this task
  const session = ensureSession(tabId, { url: '', id: chrome.runtime.id } as chrome.runtime.MessageSender);
  session.activeAbortController = new AbortController();

  // Notify Side Panel of vision mode availability
  if (!hasDoubaoVision) {
    const missing = [];
    if (!hasDoubaoKey) missing.push('ARK API Key');
    if (!hasDoubaoEp) missing.push('Endpoint ID');
    broadcastToSidePanel({
      type: 'step_status',
      stepId: 'warning',
      status: 'thinking',
      detail: `豆包视觉未配置（${missing.join(' + ')}），将使用纯文本模式`,
    });
  }

  // Run the ReAct loop
  const { runReactLoop } = await import('./react-loop');

  try {
    await runReactLoop({
      tabId,
      userTask: text,
      abortSignal: session.activeAbortController.signal,
      onStreamUpdate: (update) => {
        broadcastToSidePanel(update as unknown as Record<string, unknown>);
      },
      onStepComplete: (_step) => {
        // Update token count in Side Panel
        broadcastToSidePanel({
          type: 'cost_update',
          tabId,
          totalTokens: session.totalTokens,
          estimatedCost: estimateCost(session.totalTokens),
          modelBreakdown: {
            deepseek: {
              tokens: session.totalTokens,
              cost: estimateCost(session.totalTokens),
            },
          },
        });
      },
      onAskUser: (question: string) => {
        return new Promise<string | null>((resolve) => {
          const requestId = crypto.randomUUID();
          pendingAskUser.set(tabId, (answer) => resolve(answer));

          broadcastToSidePanel({
            type: 'ask_user_prompt',
            question,
            requestId,
          });

          // Also handle via session abort
          session.activeAbortController?.signal.addEventListener('abort', () => {
            pendingAskUser.delete(tabId);
            resolve(null);
          }, { once: true });
        });
      },
      onComplete: (summary: string) => {
        broadcastToSidePanel({
          type: 'step_status',
          stepId: 'done',
          status: 'completed',
          detail: `任务完成: ${summary}`,
        });
        session.activeAbortController = null;
      },
      onError: (error: Error, stepIndex: number) => {
        broadcastToSidePanel({
          type: 'step_status',
          stepId: `error_${stepIndex}`,
          status: 'errored',
          detail: `错误: ${error.message.slice(0, 200)}`,
        });
        session.activeAbortController = null;
      },
    }).catch((err) => {
      console.error('[worker] ReAct loop error:', err);
      broadcastToSidePanel({
        type: 'step_status',
        stepId: 'fatal',
        status: 'errored',
        detail: `严重错误: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`,
      });
      session.activeAbortController = null;
    });
  } catch (err) {
    // Already handled in runReactLoop
    session.activeAbortController = null;
  }
}

// Expose stop check for react-loop (avoids circular import)
(globalThis as any).__stopRequested = (tabId: number) => stopFlags.get(tabId) === true;

async function handleStopTask(tabId: number): Promise<void> {
  // Set global stop flag — checked by ReAct loop
  stopFlags.set(tabId, true);

  const session = sessions.get(tabId);
  if (session?.activeAbortController) {
    session.activeAbortController.abort();
    session.activeAbortController = null;
  }

  // Also resolve any pending ask_user with null
  const resolver = pendingAskUser.get(tabId);
  if (resolver) {
    resolver(null!);
    pendingAskUser.delete(tabId);
  }

  broadcastToSidePanel({
    type: 'step_status',
    stepId: 'stop',
    status: 'completed',
    detail: '任务已取消',
  });
}

/** Check if stop was requested for a tab. */
export function isStopRequested(tabId: number): boolean {
  return stopFlags.get(tabId) === true;
}

/** Clear stop flag (called when starting a new task). */
export function clearStopFlag(tabId: number): void {
  stopFlags.delete(tabId);
}

function handleAskUserResponse(tabId: number, answer: string): void {
  const resolver = pendingAskUser.get(tabId);
  if (resolver) {
    resolver(answer);
    pendingAskUser.delete(tabId);
  }
}

/** Rough cost estimation for DeepSeek V4 Pro: ~¥1.5/1M tokens. */
function estimateCost(totalTokens: number): number {
  return (totalTokens / 1_000_000) * 1.5;
}

// ─── Action Router ─────────────────────────────────────────────────────────

async function handleAction(msg: ActionRequest): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { action, tabId } = msg;
  const session = sessions.get(tabId);
  const abortSignal = session?.activeAbortController?.signal;

  // Check if this action requires a content script round-trip
  const contentActions = new Set([
    'get_page_semantic_structure',
    'extract_text',
    'tag_elements',
    'call_vision_model',
    'execute_click',
    'execute_type',
    'hover',
    'press_key',
    'scroll_page',
    'wait_for',
    'handle_dialog',
    'execute_javascript',
  ]);

  if (contentActions.has(action)) {
    return sendToContentScript(tabId, msg, abortSignal);
  }

  // Actions handled directly by the Background Worker (no content script needed)
  switch (action) {
    case 'ask_user':
      return handleAskUser(tabId, msg);
    case 'finish_task':
      return handleFinishTask(tabId, msg);
    case 'navigate_to_url':
      return handleNavigateToUrl(tabId, msg);
    default:
      return { success: false, error: `Unhandled action: ${action}` };
  }
}

// ─── Safe Content Script Communication (Navigation Guard) ──────────────────

async function sendToContentScript(
  tabId: number,
  message: ActionRequest,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    // Ensure content script is injected (may have missed injection on already-open tabs)
    await ensureContentScriptInjected(tabId);

    const tab = await chrome.tabs.get(tabId);
    if (tab.pendingUrl) {
      return { success: false, error: 'Tab is navigating — operation aborted' };
    }

    const documentId = (tab as unknown as { documentId: string }).documentId;

    const response = await new Promise<{ success: boolean; data?: unknown; error?: string }>((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve({ success: false, error: 'Content script did not respond within timeout' });
      }, SEND_MESSAGE_TIMEOUT_MS);

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
          resolve({ success: false, error: 'Operation aborted by user' });
        }, { once: true });
      }

      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response ?? { success: false, error: 'No response from content script' });
        }
      });
    });

    // Verify documentId hasn't changed
    const currentTab = await chrome.tabs.get(tabId);
    if ((currentTab as unknown as { documentId: string }).documentId !== documentId) {
      return { success: false, error: 'Navigation occurred during operation — result discarded' };
    }

    return response;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Track which tabs we've already injected into. */
const injectedTabs = new Set<number>();

/**
 * Programmatically inject the content script into a tab.
 * Handles the case where the tab was open before the extension was installed/updated.
 */
async function ensureContentScriptInjected(tabId: number): Promise<void> {
  if (injectedTabs.has(tabId)) return;

  try {
    // Check if content script is already loaded by pinging it
    const isLoaded = await new Promise<boolean>((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: 'ping', protocolVersion: 1, requestId: 'ping', tabId }, (resp) => {
        resolve(!chrome.runtime.lastError && resp?.success === true);
      });
    });

    if (!isLoaded) {
      // Inject programmatically
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js'],
      });
      // Wait a tick for the content script to initialize
      await new Promise((r) => setTimeout(r, 200));
    }

    injectedTabs.add(tabId);
  } catch {
    // If we can't inject (e.g., chrome:// pages), just proceed — sendMessage will fail with a clear error
  }
}

// ─── Screenshot API ────────────────────────────────────────────────────────

interface ScreenshotOptions {
  tabId: number;
  cropRegion?: { x: number; y: number; width: number; height: number };
  quality?: number;
}

/**
 * Capture a screenshot of the active tab with domain authorization.
 *
 * Process:
 *   1. Check domain authorization (ask user if first time)
 *   2. Capture full viewport screenshot
 *   3. Crop to tagged element bounds (if available)
 *   4. Apply DPR correction
 */
async function captureScreenshot(options: ScreenshotOptions): Promise<{ success: boolean; dataUrl?: string; error?: string }> {
  try {
    const tab = await chrome.tabs.get(options.tabId);

    // Extract domain for authorization
    const url = new URL(tab.url ?? 'about:blank');
    const domain = url.hostname;

    // Check domain block list
    const { getDomainBlockList } = await import('../shared/storage');
    const blockList = await getDomainBlockList();
    if (blockList.includes(domain)) {
      return { success: false, error: `Screenshots are blocked for ${domain}` };
    }

    // Check domain authorization
    const auth = await getDomainScreenshotAuth(domain);
    if (auth === 'never') {
      return { success: false, error: `Screenshots are not authorized for ${domain}` };
    }

    if (!auth) {
      // First time on this domain — need user consent
      // This would trigger the Side Panel to ask the user
      // For now, default to 'session' if auto-approve is on
      const { getUserPreferences } = await import('../shared/storage');
      const prefs = await getUserPreferences();
      if (prefs.autoApproveScreenshots) {
        await setDomainScreenshotAuth(domain, 'session');
      } else {
        return { success: false, error: `Screenshot authorization required for ${domain}` };
      }
    }

    // Capture screenshot
    const format = 'png';
    const dataUrl = await chrome.tabs.captureVisibleTab(
      tab.windowId,
      { format, quality: SCREENSHOT_QUALITY },
    );

    // If a crop region is specified, crop the screenshot
    if (options.cropRegion && options.cropRegion.width > 0 && options.cropRegion.height > 0) {
      const cropped = await cropImageDataUrl(dataUrl, options.cropRegion);
      return { success: true, dataUrl: cropped };
    }

    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Crop a data URL image to the specified region.
 */
async function cropImageDataUrl(
  dataUrl: string,
  region: { x: number; y: number; width: number; height: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = new OffscreenCanvas(region.width, region.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(
        img,
        region.x, region.y, region.width, region.height,
        0, 0, region.width, region.height,
      );

      canvas.convertToBlob({ type: 'image/png' }).then((blob) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Failed to read cropped image'));
        reader.readAsDataURL(blob);
      }).catch(reject);
    };
    img.onerror = () => reject(new Error('Failed to load screenshot image'));
    img.src = dataUrl;
  });
}

// ─── DeepSeek API ──────────────────────────────────────────────────────────

interface DeepSeekRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
  max_tokens?: number;
}

/**
 * Call the DeepSeek API with streaming support.
 */
async function callDeepSeek(
  request: DeepSeekRequest,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const apiKey = await loadApiKey('deepseek');
  if (!apiKey) {
    return { success: false, error: 'DeepSeek API key not configured' };
  }

  const result = await fetchWithRetry<unknown>(
    DEEPSEEK_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal: abortSignal,
    },
  );

  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ─── Doubao Vision API ─────────────────────────────────────────────────────

/**
 * Call the Doubao Vision API with a screenshot.
 * Uses circuit breaker — 3 consecutive failures → degrade to text-only mode.
 */
async function callDoubaoVision(
  imageBase64: string,
  question: string,
  tabId: number,
): Promise<{ success: boolean; elementId?: number; error?: string }> {
  const session = sessions.get(tabId);

  // Check circuit breaker
  if (session?.doubaoCircuitOpen) {
    return { success: false, error: 'Doubao Vision circuit breaker open. Using text-only mode.' };
  }

  const apiKey = await loadApiKey('doubao');
  if (!apiKey) {
    return { success: false, error: 'Doubao API key not configured' };
  }

  const result = await fetchWithRetry<{
    choices: Array<{ message: { content: string } }>;
  }>(
    DOUBAO_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'doubao-vision-pro-32k',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${imageBase64}` },
              },
              {
                type: 'text',
                text: question,
              },
            ],
          },
        ],
        max_tokens: 500,
      }),
    },
  );

  if (result.success && result.data) {
    // Reset circuit breaker on success
    if (session) {
      session.doubaoFailures = 0;
      session.doubaoCircuitOpen = false;
    }

    // Parse the response to extract element ID
    const content = result.data.choices[0]?.message?.content ?? '';
    const idMatch = content.match(/\b(\d+)\b/);
    const elementId = idMatch ? parseInt(idMatch[1], 10) : undefined;

    return { success: true, elementId };
  }

  // Track failures for circuit breaker
  if (session) {
    session.doubaoFailures++;
    if (session.doubaoFailures >= 3) {
      session.doubaoCircuitOpen = true;
      console.warn(`[worker] Doubao Vision circuit breaker opened for tab ${tabId} after 3 consecutive failures.`);
    }
  }

  return { success: false, error: result.error };
}

// ─── ask_user / finish_task Handlers ───────────────────────────────────────

async function handleNavigateToUrl(
  tabId: number,
  msg: ActionRequest & { action: 'navigate_to_url' },
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const url = msg.url.startsWith('http') ? msg.url : `https://${msg.url}`;
    await chrome.tabs.update(tabId, { url });
    // Clear injection cache since we're navigating
    injectedTabs.delete(tabId);
    return { success: true, data: { navigated: true, url } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleAskUser(
  _tabId: number,
  msg: ActionRequest & { action: 'ask_user' },
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // Forward to Side Panel
  // The Side Panel will present the question to the user and return the answer
  return {
    success: true,
    data: {
      question: msg.question,
      answered: false,
    },
  };
}

async function handleFinishTask(
  tabId: number,
  msg: ActionRequest & { action: 'finish_task' },
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  // Clean up the session
  const session = sessions.get(tabId);
  if (session) {
    session.activeAbortController?.abort();
    sessions.delete(tabId);
  }

  await unregisterActiveSession(tabId);

  return {
    success: true,
    data: { summary: msg.summary, acknowledged: true },
  };
}

// ─── Session Management ────────────────────────────────────────────────────

function ensureSession(tabId: number, sender: chrome.runtime.MessageSender): TabSession {
  let session = sessions.get(tabId);
  if (!session) {
    session = {
      tabId,
      documentId: '', // Will be filled on first operation
      activeAbortController: null,
      conversationHistory: [],
      totalTokens: 0,
      doubaoFailures: 0,
      doubaoCircuitOpen: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    sessions.set(tabId, session);

    // Also register in persistent storage for recovery
    registerActiveSession({
      tabId,
      url: sender.url ?? 'unknown',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      loopStatus: 'idle',
    }).catch(console.error);
  }

  session.lastActivityAt = Date.now();
  return session;
}

// ─── Settings Port Handler ─────────────────────────────────────────────────

/**
 * Handle 'settings' port connections (from the Options page).
 * Supports: get_api_key_status, store_api_key, store_doubao_endpoint, test_api_key, test_doubao
 */
function setupSettingsPort(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'settings') return;

    port.onMessage.addListener(async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case 'get_api_key_status': {
          const { hasApiKey, hasDoubaoEndpointId, loadDoubaoEndpointId } = await import('../shared/encryption');
          port.postMessage({
            type: 'api_key_status',
            deepseekConfigured: await hasApiKey('deepseek'),
            doubaoApiKeyConfigured: await hasApiKey('doubao'),
            doubaoEndpointConfigured: await hasDoubaoEndpointId(),
            doubaoEndpointId: await loadDoubaoEndpointId(),
          });
          break;
        }

        case 'store_api_key': {
          const keyType = msg.keyType as 'deepseek' | 'doubao';
          const apiKey = msg.apiKey as string;

          if (!apiKey || apiKey.length < 5) {
            port.postMessage({ type: 'api_key_test_result', success: false, error: 'Key 格式无效（太短）' });
            return;
          }

          const { storeApiKey, initializeEncryption } = await import('../shared/encryption');
          await initializeEncryption();
          await storeApiKey(keyType, apiKey);
          console.log(`[worker] ${keyType} API key stored.`);
          break;
        }

        case 'store_doubao_endpoint': {
          const endpointId = msg.endpointId as string;
          if (!endpointId || !endpointId.startsWith('ep-')) {
            port.postMessage({ type: 'api_key_test_result', success: false, error: 'Endpoint ID 应以 ep- 开头' });
            return;
          }
          const { storeDoubaoEndpointId } = await import('../shared/encryption');
          await storeDoubaoEndpointId(endpointId);
          console.log('[worker] Doubao endpoint ID stored.');
          break;
        }

        case 'test_api_key': {
          const keyType = msg.keyType as 'deepseek' | 'doubao';
          const apiKey = msg.apiKey as string;

          try {
            const url = keyType === 'deepseek'
              ? 'https://api.deepseek.com/v1/models'
              : 'https://ark.cn-beijing.volces.com/api/v3/models';

            const response = await fetch(url, {
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
            });

            port.postMessage({
              type: 'api_key_test_result',
              success: response.ok,
              error: response.ok ? undefined : `HTTP ${response.status}: ${await response.text().then(t => t.slice(0, 100))}`,
            });
          } catch (err) {
            port.postMessage({
              type: 'api_key_test_result',
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }

        case 'test_doubao': {
          const apiKey = msg.apiKey as string;
          const endpointId = msg.endpointId as string;

          try {
            // Test with a minimal chat request to verify both API key and endpoint
            const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: endpointId,
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 5,
              }),
            });

            port.postMessage({
              type: 'api_key_test_result',
              success: response.ok,
              error: response.ok ? undefined : `HTTP ${response.status}: ${await response.text().then(t => t.slice(0, 100))}`,
            });
          } catch (err) {
            port.postMessage({
              type: 'api_key_test_result',
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
      }
    });
  });
}

// ─── Exports for testing ───────────────────────────────────────────────────

export { captureScreenshot, callDeepSeek, callDoubaoVision };

// ─── Start ─────────────────────────────────────────────────────────────────

initialize().catch(console.error);
setupSettingsPort();
