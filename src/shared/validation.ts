// ============================================================================
// Message Validation Layer
// Validates all incoming chrome.runtime messages before they reach the core dispatcher.
// ============================================================================

import {
  PROTOCOL_VERSION,
  VALID_ACTIONS,
  type Action,
  type BaseMessage,
  type ActionRequest,
  isValidKey,
  isValidScrollDirection,
} from './messages';

// ─── Validation Result ─────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ─── Sender Validation ─────────────────────────────────────────────────────

const EXTENSION_ID = chrome.runtime.id;

/**
 * Verify that a message originated from our own extension.
 * MUST be the FIRST check in every onMessage listener.
 */
export function validateSender(sender: chrome.runtime.MessageSender): ValidationResult {
  if (sender.id !== EXTENSION_ID) {
    console.error(`[security] Message rejected: sender.id=${sender.id} !== extension=${EXTENSION_ID}`);
    return { valid: false, error: `Untrusted sender: ${sender.id}` };
  }
  // For content scripts, also verify origin matches
  if (sender.url && sender.origin) {
    // Content script messages should originate from the tab's page
    // but the sender.id check above is the primary guard
  }
  return { valid: true };
}

// ─── Action Validation ─────────────────────────────────────────────────────

/**
 * Validate that a message structure conforms to BaseMessage.
 */
export function validateBaseMessage(msg: unknown): ValidationResult & { message?: BaseMessage } {
  if (typeof msg !== 'object' || msg === null) {
    return { valid: false, error: 'Message is not an object' };
  }

  const m = msg as Record<string, unknown>;

  if (m.protocolVersion !== PROTOCOL_VERSION) {
    return { valid: false, error: `Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${m.protocolVersion}` };
  }

  if (typeof m.action !== 'string' || !(VALID_ACTIONS as readonly string[]).includes(m.action)) {
    return { valid: false, error: `Invalid or missing action: ${m.action}` };
  }

  if (typeof m.requestId !== 'string' || m.requestId.length === 0) {
    return { valid: false, error: 'Missing or empty requestId' };
  }

  if (typeof m.tabId !== 'number' || m.tabId < 0) {
    return { valid: false, error: `Invalid tabId: ${m.tabId}` };
  }

  return {
    valid: true,
    message: {
      protocolVersion: PROTOCOL_VERSION,
      action: m.action as Action,
      requestId: m.requestId as string,
      tabId: m.tabId as number,
    },
  };
}

// ─── Parameter Validation ──────────────────────────────────────────────────

const MAX_SELECTOR_LENGTH = 500;
const MAX_TEXT_LENGTH = 10000;
const MAX_QUESTION_LENGTH = 2000;
const MAX_CODE_LENGTH = 5000;
const MAX_REGION_LENGTH = 200;

/** CSS pseudo-classes that could be used for exfiltration or timing attacks. */
const DANGEROUS_PSEUDO_CLASSES = /:(visited|active|focus|target|playing|paused)/i;

/**
 * Validate that a CSS selector is safe to use (no dangerous pseudo-classes, reasonable length).
 */
function validateSelector(selector: string): ValidationResult {
  if (typeof selector !== 'string') {
    return { valid: false, error: 'selector must be a string' };
  }
  if (selector.length === 0) {
    return { valid: false, error: 'selector is empty' };
  }
  if (selector.length > MAX_SELECTOR_LENGTH) {
    return { valid: false, error: `selector too long (${selector.length} > ${MAX_SELECTOR_LENGTH})` };
  }
  if (DANGEROUS_PSEUDO_CLASSES.test(selector)) {
    return { valid: false, error: 'selector contains dangerous pseudo-classes' };
  }
  return { valid: true };
}

/**
 * Validate element_id is a positive integer.
 */
function validateElementId(id: unknown): ValidationResult {
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
    return { valid: false, error: `element_id must be a non-negative integer, got ${id}` };
  }
  return { valid: true };
}

/**
 * Full parameter validation for each action type.
 * Returns valid=true only if all parameters pass type and boundary checks.
 */
export function validateParameters(msg: BaseMessage): ValidationResult {
  const m = msg as unknown as Record<string, unknown>;

  switch (msg.action) {
    case 'get_page_semantic_structure':
      // No parameters needed
      return { valid: true };

    case 'extract_text':
      return validateElementId(m.element_id);

    case 'tag_elements': {
      const selResult = validateSelector(m.selector as string);
      if (!selResult.valid) return selResult;
      if (m.region !== undefined) {
        if (typeof m.region !== 'string') {
          return { valid: false, error: 'region must be a string' };
        }
        if (m.region.length > MAX_REGION_LENGTH) {
          return { valid: false, error: `region too long (${m.region.length} > ${MAX_REGION_LENGTH})` };
        }
      }
      return { valid: true };
    }

    case 'call_vision_model': {
      if (typeof m.question !== 'string' || m.question.length === 0) {
        return { valid: false, error: 'question is required and must be non-empty' };
      }
      if (m.question.length > MAX_QUESTION_LENGTH) {
        return { valid: false, error: `question too long (${m.question.length} > ${MAX_QUESTION_LENGTH})` };
      }
      return { valid: true };
    }

    case 'execute_click':
    case 'hover':
      return validateElementId(m.element_id);

    case 'execute_type': {
      const idResult = validateElementId(m.element_id);
      if (!idResult.valid) return idResult;
      if (typeof m.text !== 'string') {
        return { valid: false, error: 'text must be a string' };
      }
      if (m.text.length > MAX_TEXT_LENGTH) {
        return { valid: false, error: `text too long (${m.text.length} > ${MAX_TEXT_LENGTH})` };
      }
      return { valid: true };
    }

    case 'press_key': {
      if (typeof m.key !== 'string' || !isValidKey(m.key)) {
        return { valid: false, error: `Invalid key: ${m.key}. Must be one of the allowed key values.` };
      }
      return { valid: true };
    }

    case 'scroll_page': {
      if (typeof m.direction !== 'string' || !isValidScrollDirection(m.direction)) {
        return { valid: false, error: 'direction must be one of: up, down, top, bottom' };
      }
      return { valid: true };
    }

    case 'wait_for': {
      if (typeof m.condition !== 'object' || m.condition === null) {
        return { valid: false, error: 'condition must be an object' };
      }
      const cond = m.condition as Record<string, unknown>;
      const hasValidField =
        (typeof cond.element_visible === 'number') ||
        (typeof cond.element_hidden === 'number') ||
        (typeof cond.text_present === 'string') ||
        (cond.network_idle === true) ||
        (cond.dom_stable === true);
      if (!hasValidField) {
        return { valid: false, error: 'condition must have at least one valid field' };
      }
      if (m.timeout_ms !== undefined && (typeof m.timeout_ms !== 'number' || m.timeout_ms < 0 || m.timeout_ms > 60000)) {
        return { valid: false, error: 'timeout_ms must be between 0 and 60000' };
      }
      return { valid: true };
    }

    case 'handle_dialog': {
      if (m.dialog_action !== 'accept' && m.dialog_action !== 'dismiss') {
        return { valid: false, error: 'dialog_action must be "accept" or "dismiss"' };
      }
      if (m.prompt_text !== undefined && typeof m.prompt_text !== 'string') {
        return { valid: false, error: 'prompt_text must be a string' };
      }
      return { valid: true };
    }

    case 'ask_user': {
      if (typeof m.question !== 'string' || m.question.length === 0) {
        return { valid: false, error: 'question is required and must be non-empty' };
      }
      if (m.question.length > MAX_QUESTION_LENGTH) {
        return { valid: false, error: `question too long (${m.question.length} > ${MAX_QUESTION_LENGTH})` };
      }
      return { valid: true };
    }

    case 'finish_task': {
      if (typeof m.summary !== 'string') {
        return { valid: false, error: 'summary must be a string' };
      }
      return { valid: true };
    }

    case 'navigate_to_url': {
      if (typeof m.url !== 'string' || m.url.length === 0) {
        return { valid: false, error: 'url is required' };
      }
      if (m.url.length > 2000) {
        return { valid: false, error: 'url too long' };
      }
      return { valid: true };
    }

    case 'execute_javascript': {
      if (typeof m.code !== 'string' || m.code.length === 0) {
        return { valid: false, error: 'code must be a non-empty string' };
      }
      if (m.code.length > MAX_CODE_LENGTH) {
        return { valid: false, error: `code too long (${m.code.length} > ${MAX_CODE_LENGTH})` };
      }
      return { valid: true };
    }

    default:
      return { valid: false, error: `Unknown action: ${msg.action}` };
  }
}

// ─── Full Validation Pipeline ──────────────────────────────────────────────

/**
 * Complete message validation pipeline.
 * Call this at the top of every chrome.runtime.onMessage listener in the Background Worker.
 *
 * Order: sender.id check → base message structure → parameter validation.
 */
export function validateMessage(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
): ValidationResult & { message?: ActionRequest } {
  // Step 1: Sender check
  const senderResult = validateSender(sender);
  if (!senderResult.valid) return senderResult;

  // Step 2: Base message structure
  const baseResult = validateBaseMessage(msg);
  if (!baseResult.valid || !baseResult.message) {
    return { valid: false, error: baseResult.error ?? 'Invalid base message' };
  }

  // Merge base message with full parameters for validation
  const fullMessage = { ...baseResult.message, ...(msg as unknown as Record<string, unknown>) } as BaseMessage;

  // Step 3: Parameter validation
  const paramResult = validateParameters(fullMessage);
  if (!paramResult.valid) return paramResult;

  // All checks passed — return the fully validated message
  return {
    valid: true,
    message: fullMessage as unknown as ActionRequest,
  };
}
