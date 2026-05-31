// ============================================================================
// Doubao Vision API Client
//
// Non-streaming request-response. Sends a cropped screenshot + question
// to Doubao's vision model, returns the identified element ID.
//
// Features:
//   - Circuit breaker: 3 consecutive failures → degrade to text-only mode
//   - DPR-aware coordinate correction
//   - Domain-level screenshot authorization check
// ============================================================================

import { fetchWithRetry } from '../shared/retry';
import { loadApiKey, loadDoubaoEndpointId } from '../shared/encryption';

// ─── Constants ─────────────────────────────────────────────────────────────

const DOUBAO_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const MAX_TOKENS = 500;
const TEMPERATURE = 0.1; // Low temp for accuracy in ID identification

// ─── Circuit Breaker ──────────────────────────────────────────────────────

interface CircuitState {
  consecutiveFailures: number;
  lastFailureTime: number;
  open: boolean;
}

const circuits = new Map<number, CircuitState>(); // Per tabId

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 120_000; // 2 minutes auto-reset

function getCircuit(tabId: number): CircuitState {
  let circuit = circuits.get(tabId);
  if (!circuit) {
    circuit = { consecutiveFailures: 0, lastFailureTime: 0, open: false };
    circuits.set(tabId, circuit);
  }
  return circuit;
}

export function isDoubaoCircuitOpen(tabId: number): boolean {
  const circuit = getCircuit(tabId);
  // Auto-reset after cooldown period
  if (circuit.open && Date.now() - circuit.lastFailureTime > CIRCUIT_RESET_MS) {
    circuit.open = false;
    circuit.consecutiveFailures = 0;
  }
  return circuit.open;
}

export function resetDoubaoCircuit(tabId: number): void {
  circuits.delete(tabId);
}

export function getDoubaoCircuitStatus(tabId: number): {
  open: boolean;
  consecutiveFailures: number;
} {
  const circuit = getCircuit(tabId);
  return {
    open: circuit.open,
    consecutiveFailures: circuit.consecutiveFailures,
  };
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DoubaoVisionRequest {
  /** Base64-encoded PNG image (WITHOUT the data:image/png;base64, prefix) */
  imageBase64: string;
  /** The question to ask about the image. */
  question: string;
  /** Device pixel ratio for coordinate correction. */
  devicePixelRatio?: number;
}

export interface DoubaoVisionResponse {
  success: boolean;
  /** The element ID identified by the vision model. */
  elementId?: number;
  /** Model's reasoning (if available). */
  reasoning?: string;
  /** Confidence score (estimated). */
  confidence?: number;
  error?: string;
}

// ─── API Call ──────────────────────────────────────────────────────────────

/**
 * Call the Doubao Vision API to identify which tagged element matches the query.
 *
 * The image should be a cropped screenshot (tag element bounds union + 20px margin).
 * The question should ask about a specific element, e.g. "搜索按钮的编号是几？"
 *
 * @param tabId - Tab ID for circuit breaker tracking
 * @param request - Vision request with image and question
 * @returns Identified element ID or error
 */
export async function callDoubaoVision(
  tabId: number,
  request: DoubaoVisionRequest,
): Promise<DoubaoVisionResponse> {
  // Check circuit breaker
  const circuit = getCircuit(tabId);
  if (circuit.open) {
    if (Date.now() - circuit.lastFailureTime > CIRCUIT_RESET_MS) {
      // Auto-reset
      circuit.open = false;
      circuit.consecutiveFailures = 0;
    } else {
      return {
        success: false,
        error: 'Doubao Vision circuit breaker open. Using text-only fallback mode.',
      };
    }
  }

  const apiKey = await loadApiKey('doubao');
  if (!apiKey) {
    return { success: false, error: '豆包 API Key 未配置。请在设置页面填入 ARK API Key。' };
  }

  const endpointId = await loadDoubaoEndpointId();
  if (!endpointId) {
    return { success: false, error: '豆包 Endpoint ID (ep-xxx) 未配置。请在设置页面填入接入点 ID。' };
  }

  // Build a structured prompt for element ID identification
  const systemPrompt = `你是一个视觉识别助手。图片中叠加了红色数字标签。请仔细查看图片中的数字标签，回答用户关于标签编号的问题。
规则：
- 只返回一个数字 ID
- 如果无法确定，返回 -1
- 不要返回任何其他文字，只返回数字`;

  const userPrompt = `${request.question}\n\n请返回对应的标签数字编号。只返回数字，不要其他内容。`;

  const result = await fetchWithRetry<{
    choices: Array<{
      message: { content: string };
      finish_reason: string;
    }>;
    usage: { total_tokens: number };
  }>(
    DOUBAO_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: endpointId,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${request.imageBase64}`,
                  detail: 'high',
                },
              },
              {
                type: 'text',
                text: userPrompt,
              },
            ],
          },
        ],
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }),
    },
    {
      maxRetries: 2,
      baseDelayMs: 500,
      timeoutMs: 15000,
    },
  );

  if (!result.success || !result.data) {
    // Record failure
    circuit.consecutiveFailures++;
    circuit.lastFailureTime = Date.now();
    if (circuit.consecutiveFailures >= CIRCUIT_THRESHOLD) {
      circuit.open = true;
      console.warn(`[doubao] Circuit breaker opened for tab ${tabId} after ${CIRCUIT_THRESHOLD} consecutive failures`);
    }
    return {
      success: false,
      error: result.error ?? 'Doubao Vision API call failed',
    };
  }

  // Parse response
  const content = result.data.choices[0]?.message?.content ?? '';
  const trimmed = content.trim();

  // Extract numeric ID from response
  const idMatch = trimmed.match(/-?\b(\d+)\b/);
  const elementId = idMatch ? parseInt(idMatch[1], 10) : undefined;

  // Infer confidence from response format
  let confidence = 0.5;
  if (elementId && trimmed === String(elementId)) {
    confidence = 0.95; // Exact numeric match — high confidence
  } else if (elementId && trimmed.match(/^\d+$/)) {
    confidence = 0.9;
  } else if (elementId) {
    confidence = 0.7; // ID found within other text
  } else if (trimmed === '-1' || trimmed.includes('-1')) {
    confidence = 0.8; // Model explicitly said it can't find it
  }

  // Record success
  circuit.consecutiveFailures = 0;

  return {
    success: true,
    elementId: elementId && elementId >= 0 ? elementId : undefined,
    reasoning: content,
    confidence,
  };
}

// ─── DPR Coordinate Correction ─────────────────────────────────────────────

/**
 * Correct vision model coordinates for device pixel ratio.
 *
 * Screenshots are captured at native resolution (physical pixels).
 * If the vision model returns coordinates in physical pixels,
 * divide by DPR to get CSS pixels for DOM interaction.
 *
 * @param physicalCoordinate - Coordinate as returned by vision model
 * @param dpr - window.devicePixelRatio
 * @returns CSS pixel coordinate
 */
export function correctCoordinateForDPR(
  physicalCoordinate: number,
  dpr: number,
): number {
  return Math.round(physicalCoordinate / dpr);
}

// ─── Image Processing ──────────────────────────────────────────────────────

/**
 * Remove the data URL prefix from a base64 image string.
 *
 * @param dataUrl - Full data URL like "data:image/png;base64,iVBORw..."
 * @returns Raw base64 string without the prefix
 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex >= 0) {
    return dataUrl.slice(commaIndex + 1);
  }
  return dataUrl; // Assume already stripped
}

// ─── Degradation Notice ────────────────────────────────────────────────────

/**
 * Build a degradation notice when the vision model is unavailable.
 * Informs the user that the agent has switched to text-only mode.
 */
export function buildDegradationNotice(): string {
  return '视觉模型暂时不可用，已切换到纯文本模式。操作准确率可能降低，建议为关键操作提供额外确认。';
}

// ─── Coverage Element Hiding ───────────────────────────────────────────────

/**
 * CSS selector patterns for common overlay elements that might obscure tags.
 * These are temporarily hidden during screenshot capture, then restored.
 */
const OVERLAY_SELECTORS = [
  // Cookie consent banners
  '[id*="cookie"]',
  '[class*="cookie-consent"]',
  '[class*="cookie-banner"]',
  // Fixed headers that might sit on top of tagged elements
  'header[class*="fixed"]',
  'header[class*="sticky"]',
  '.fixed-header',
  '.sticky-header',
  '[class*="sticky-top"]',
  // Fixed chat/widget buttons
  '[class*="chat-widget"]',
  '[class*="live-chat"]',
  '[class*="intercom"]',
  // Notification toasts
  '[class*="toast"]',
  '[class*="notification-bar"]',
  // Fixed bottom bars
  '[class*="fixed-bottom"]',
  '[class*="sticky-bottom"]',
];

/**
 * Get overlay hiding CSS for use in content script before screenshot.
 * Returns CSS that hides overlays without removing them from the DOM.
 */
export function getOverlayHideCSS(): string {
  return OVERLAY_SELECTORS.map((sel) => `${sel}{display:none!important;visibility:hidden!important}`).join('\n');
}
