// ============================================================================
// Action Executor (executor.ts — ISOLATED world)
//
// Executes DOM operations via descriptor-driven approach:
//   1. Re-resolve element by locator BEFORE every operation (no stale refs)
//   2. Compute pre-operation state hash
//   3. Execute operation
//   4. Compute post-operation state hash
//   5. Mark extraction results as stale
//
// Supports: click, type, hover, press_key, scroll_page, wait_for, handle_dialog
// ============================================================================

import { resolveElementById, isElementStillValid } from './injector';

// ─── Operation Types ───────────────────────────────────────────────────────

export interface ClickParams {
  elementId: number;
}

export interface TypeParams {
  elementId: number;
  text: string;
}

export interface HoverParams {
  elementId: number;
}

export interface PressKeyParams {
  key: string;
}

export interface ScrollPageParams {
  direction: 'up' | 'down' | 'top' | 'bottom';
}

export interface WaitForParams {
  condition: {
    element_visible?: number;
    element_hidden?: number;
    text_present?: string;
    network_idle?: boolean;
    dom_stable?: boolean;
  };
  timeoutMs?: number;
}

export interface HandleDialogParams {
  action: 'accept' | 'dismiss';
  promptText?: string;
}

export type OperationParams =
  | ClickParams
  | TypeParams
  | HoverParams
  | PressKeyParams
  | ScrollPageParams
  | WaitForParams
  | HandleDialogParams;

// ─── Operation Result ──────────────────────────────────────────────────────

export interface OperationResult {
  success: boolean;
  actionTaken: string;
  preOperationHash: string;
  postOperationHash: string;
  error?: string;
  newUrl?: string; // Set if navigation occurred
  dialogHandled?: boolean;
}

// ─── Operation History (for idempotency tracking) ──────────────────────────

interface OperationRecord {
  action: string;
  params: string; // JSON representation for comparison
  timestamp: number;
  hash: string;
}

const operationHistory: OperationRecord[] = [];
const MAX_OPERATION_HISTORY = 50;

function recordOperation(action: string, params: unknown, hash: string): void {
  operationHistory.push({
    action,
    params: JSON.stringify(params),
    timestamp: Date.now(),
    hash,
  });
  if (operationHistory.length > MAX_OPERATION_HISTORY) {
    operationHistory.shift();
  }
}

/**
 * Check if a non-idempotent operation has been executed before.
 * Prevents issues like clicking a toggle 3 times (on → off → on again).
 */
function hasBeenExecuted(action: string, params: unknown): boolean {
  const paramsStr = JSON.stringify(params);
  // Only check recent operations (last 10)
  const recent = operationHistory.slice(-10);
  return recent.some((op) => op.action === action && op.params === paramsStr);
}

// ─── DOM State Hashing ─────────────────────────────────────────────────────

/**
 * Compute a simple hash of the DOM state for before/after comparison.
 * Uses text content of interactive elements in the viewport.
 */
function computeDomStateHash(): string {
  const interactiveSelector = 'a, button, input:not([type="hidden"]), select, textarea, [role="button"]';
  const elements = document.querySelectorAll(interactiveSelector);

  const parts: string[] = [];
  let count = 0;

  for (const el of elements) {
    if (count >= 50) break; // Sample top 50 interactive elements
    const text = (el.textContent ?? '').trim().slice(0, 50);
    const tag = el.tagName;
    const id = el.id || '';
    parts.push(`${tag}#${id}:${text}`);
    count++;
  }

  // Add URL to detect navigations
  parts.push(window.location.href);

  return simpleHash(parts.join('|'));
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// ─── Executor API ──────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000; // ms

/**
 * Execute a click operation on a tagged element.
 */
export async function executeClick(params: ClickParams): Promise<OperationResult> {
  return executeWithRetry('click', params, async () => {
    const el = mustResolveElement(params.elementId, 'click');

    // Simulate a real user click sequence
    simulateClick(el);

    return `Clicked element #${params.elementId}`;
  });
}

/**
 * Execute a type operation on a tagged element.
 */
export async function executeType(params: TypeParams): Promise<OperationResult> {
  return executeWithRetry('type', params, async () => {
    const el = mustResolveElement(params.elementId, 'type');
    const input = el as HTMLInputElement | HTMLTextAreaElement;

    // Check if this is a repeat of a non-idempotent operation
    if (hasBeenExecuted('type', { elementId: params.elementId, text: params.text.slice(0, 30) })) {
      return `Skipped duplicate type on #${params.elementId}`;
    }

    // Focus and clear existing value
    input.focus();
    input.select();

    // Use native input event to trigger React/Vue change handlers
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value',
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value',
    )?.set;

    if (input instanceof HTMLInputElement && nativeInputValueSetter) {
      nativeInputValueSetter.call(input, params.text);
    } else if (input instanceof HTMLTextAreaElement && nativeTextareaValueSetter) {
      nativeTextareaValueSetter.call(input, params.text);
    } else {
      input.value = params.text;
    }

    // Dispatch input event so frameworks detect the change
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    return `Typed "${params.text.slice(0, 50)}${params.text.length > 50 ? '…' : ''}" into #${params.elementId}`;
  });
}

/**
 * Execute a hover operation on a tagged element.
 */
export async function executeHover(params: HoverParams): Promise<OperationResult> {
  return executeWithRetry('hover', params, async () => {
    const el = mustResolveElement(params.elementId, 'hover');

    // Dispatch mouseenter + mouseover events
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));

    return `Hovered element #${params.elementId}`;
  });
}

/**
 * Execute a keyboard press.
 */
export async function executePressKey(params: PressKeyParams): Promise<OperationResult> {
  return executeWithRetry('press_key', params, async () => {
    const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
      Home: { key: 'Home', code: 'Home', keyCode: 36 },
      End: { key: 'End', code: 'End', keyCode: 35 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      'Control+A': { key: 'a', code: 'KeyA', keyCode: 65 },
      'Shift+Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    };

    const keyDef = keyMap[params.key];
    if (!keyDef) {
      throw new Error(`Unknown key: ${params.key}`);
    }

    const target = document.activeElement || document.body;

    const eventInit: KeyboardEventInit = {
      key: keyDef.key,
      code: keyDef.code,
      keyCode: keyDef.keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: params.key === 'Control+A',
      shiftKey: params.key === 'Shift+Tab',
    };

    target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

    // For Control+A, also select all text in the active input
    if (params.key === 'Control+A' && target instanceof HTMLInputElement) {
      target.select();
    }

    return `Pressed ${params.key}`;
  });
}

/**
 * Execute a scroll operation.
 */
export async function executeScrollPage(params: ScrollPageParams): Promise<OperationResult> {
  return executeWithRetry('scroll_page', params, async () => {
    const scrollAmount = window.innerHeight * 0.7; // 70% of viewport

    switch (params.direction) {
      case 'up':
        window.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
        break;
      case 'down':
        window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        break;
      case 'top':
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'bottom':
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        break;
    }

    return `Scrolled ${params.direction}`;
  });
}

/**
 * Execute a wait_for condition.
 */
export async function executeWaitFor(params: WaitForParams): Promise<OperationResult> {
  const startTime = performance.now();
  const timeoutMs = params.timeoutMs ?? 10000;
  const condition = params.condition;

  while (performance.now() - startTime < timeoutMs) {
    let met = true;

    if (condition.element_visible !== undefined) {
      const el = resolveElementById(condition.element_visible);
      if (!el || !isElementStillValid(condition.element_visible)) {
        met = false;
      }
    }

    if (condition.element_hidden !== undefined) {
      const el = resolveElementById(condition.element_hidden);
      if (el && isElementStillValid(condition.element_hidden)) {
        met = false;
      }
    }

    if (condition.text_present) {
      if (!document.body.textContent?.includes(condition.text_present)) {
        met = false;
      }
    }

    if (condition.network_idle) {
      // Simple heuristic: check if there are pending resource loads
      const pending = performance.getEntriesByType('resource').filter(
        (e) => e.duration === 0,
      );
      if (pending.length > 0) {
        met = false;
      }
    }

    if (condition.dom_stable) {
      // Simple heuristic: check if DOM changed recently
      // (The dispatcher tracks this via MutationObserver)
      // For now, just check if we've had no mutations for 200ms
      // This is a best-effort check in the content script
      met = met && true; // Placeholder — enhanced by dispatcher
    }

    if (met) {
      return {
        success: true,
        actionTaken: `Condition met after ${Math.round(performance.now() - startTime)}ms`,
        preOperationHash: '',
        postOperationHash: computeDomStateHash(),
      };
    }

    await sleep(100);
  }

  return {
    success: false,
    actionTaken: `Timeout waiting for condition`,
    preOperationHash: '',
    postOperationHash: computeDomStateHash(),
    error: `Condition not met within ${timeoutMs}ms`,
  };
}

/**
 * Handle a browser dialog (alert/confirm/prompt).
 */
export async function executeHandleDialog(params: HandleDialogParams): Promise<OperationResult> {
  // Note: In the content script, we can't truly intercept dialogs.
  // The background worker uses chrome.scripting to execute this,
  // or we use the dialog interception API.
  // For now, this is a placeholder that the background worker will override.
  return {
    success: true,
    actionTaken: `Dialog ${params.action}ed`,
    preOperationHash: '',
    postOperationHash: computeDomStateHash(),
    dialogHandled: true,
  };
}

// ─── Internal: Retry Logic ─────────────────────────────────────────────────

async function executeWithRetry(
  action: string,
  params: unknown,
  fn: () => Promise<string>,
): Promise<OperationResult> {
  const preHash = computeDomStateHash();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Re-query DOM fresh each attempt — never trust cached state
      const description = await fn();

      // Small delay to allow DOM to settle
      await sleep(200);

      const postHash = computeDomStateHash();

      // Check if DOM actually changed
      if (preHash === postHash && action !== 'scroll_page') {
        // DOM didn't change — could be a failed operation
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
          continue;
        }
      }

      recordOperation(action, params, postHash);

      return {
        success: true,
        actionTaken: description,
        preOperationHash: preHash,
        postOperationHash: postHash,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
      }
    }
  }

  return {
    success: false,
    actionTaken: `Failed: ${action}`,
    preOperationHash: preHash,
    postOperationHash: computeDomStateHash(),
    error: lastError?.message ?? 'Max retries exhausted',
  };
}

// ─── Internal: Element Resolution ──────────────────────────────────────────

function mustResolveElement(elementId: number, action: string): Element {
  const el = resolveElementById(elementId);
  if (!el) {
    throw new Error(`Element #${elementId} not found for ${action}. It may have been removed from the DOM.`);
  }
  if (!isElementStillValid(elementId)) {
    throw new Error(`Element #${elementId} is no longer valid for ${action}. Fingerprint mismatch or TTL expired.`);
  }
  return el;
}

// ─── Internal: Simulate Click ──────────────────────────────────────────────

function simulateClick(el: Element): void {
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  // Full click sequence: mousedown → mouseup → click
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
  };

  el.dispatchEvent(new MouseEvent('mousedown', eventInit));
  el.dispatchEvent(new MouseEvent('mouseup', eventInit));
  el.dispatchEvent(new MouseEvent('click', eventInit));

  // Also trigger a native click for form submissions etc.
  if (el instanceof HTMLElement) {
    el.click();
  }
}

// ─── Utility ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clear operation history (e.g., on new session). */
export function clearOperationHistory(): void {
  operationHistory.length = 0;
}
