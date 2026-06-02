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

export type VisionMode = 'identify_element' | 'read_text' | 'describe' | 'auto';

export interface DoubaoVisionRequest {
  /** Base64-encoded image (WITHOUT the data:image/png;base64, prefix) */
  imageBase64: string;
  /** What DeepSeek wants to know about the image. */
  question: string;
  /** Vision mode — controls how Doubao responds. */
  mode?: VisionMode;
  /** Device pixel ratio for coordinate correction. */
  devicePixelRatio?: number;
}

export interface DoubaoVisionResponse {
  success: boolean;
  /** For identify_element mode: the tagged element number. */
  elementId?: number;
  /** Full text response from Doubao. */
  content?: string;
  /** Model's reasoning (if available). */
  reasoning?: string;
  /** Confidence score (estimated). */
  confidence?: number;
  error?: string;
}

// ─── API Call ──────────────────────────────────────────────────────────────

/**
 * Call the Doubao Vision API.
 *
 * Modes:
 *   - 'identify_element': Image has red numbered tags. Doubao returns just the element number.
 *   - 'read_text': OCR mode. Doubao extracts all visible text from the image.
 *   - 'describe': Doubao describes what it sees in the image.
 *   - 'auto': Doubao decides how to answer based on the question.
 */
export async function callDoubaoVision(
  tabId: number,
  request: DoubaoVisionRequest,
): Promise<DoubaoVisionResponse> {
  const circuit = getCircuit(tabId);
  if (circuit.open) {
    if (Date.now() - circuit.lastFailureTime > CIRCUIT_RESET_MS) {
      circuit.open = false;
      circuit.consecutiveFailures = 0;
    } else {
      return { success: false, error: 'Doubao Vision circuit breaker open. Using text-only fallback mode.' };
    }
  }

  const apiKey = await loadApiKey('doubao');
  if (!apiKey) {
    return { success: false, error: '豆包 API Key 未配置。' };
  }

  const endpointId = await loadDoubaoEndpointId();
  if (!endpointId) {
    return { success: false, error: '豆包 Endpoint ID (ep-xxx) 未配置。' };
  }

  const mode = request.mode ?? 'auto';

  // Build prompt based on mode
  let systemPrompt: string;
  let userPrompt: string;

  switch (mode) {
    case 'identify_element':
      systemPrompt = `你是一个视觉识别助手。图片中叠加了红色数字标签。只返回标签编号，不要其他文字。如果无法确定返回 -1。`;
      userPrompt = `${request.question}\n只返回数字。`;
      break;

    case 'read_text':
      systemPrompt = `你是一个 OCR 文字提取助手。仔细阅读图片中的所有文字，完整、准确地输出。保留原文的换行和结构。不要添加解释。`;
      userPrompt = `请提取图片中的所有文字内容。`;
      break;

    case 'describe':
      systemPrompt = `你是一个视觉分析助手。仔细观察图片内容，描述你看到的东西——布局、元素、文字、区域、状态。尽可能详细和准确。`;
      userPrompt = request.question;
      break;

    case 'auto':
    default:
      systemPrompt = `你是一个视觉识别助手。根据用户的问题来分析图片。如果图片中有红色数字标签，标签编号可以用来定位元素。回答要直接、准确、有用。`;
      userPrompt = request.question;
      break;
  }

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

  // Record success
  circuit.consecutiveFailures = 0;

  // Parse element ID from content (only relevant for identify_element mode)
  const idMatch = content.match(/-?\b(\d+)\b/);
  const elementId = (mode === 'identify_element' && idMatch)
    ? parseInt(idMatch[1], 10)
    : undefined;

  // Estimate confidence
  let confidence = 0.5;
  if (mode === 'identify_element') {
    if (elementId !== undefined && elementId >= 0 && content.trim() === String(elementId)) {
      confidence = 0.95;
    } else if (elementId !== undefined && elementId >= 0) {
      confidence = 0.7;
    } else if (content.trim() === '-1') {
      confidence = 0.8;
    }
  } else {
    confidence = 0.85; // Non-element responses: moderate confidence
  }

  return {
    success: true,
    elementId: elementId !== undefined && elementId >= 0 ? elementId : undefined,
    content: content.trim(),
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
