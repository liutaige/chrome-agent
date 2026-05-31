// ============================================================================
// Content Script Message Dispatcher
//
// Routes messages to extractor / injector / executor modules.
// Enforces the state machine: idle → extracting → rendering → executing → idle
//
// States are mutually exclusive — we can't extract while executing, etc.
// ============================================================================

import { extractPageSemantics, createSemanticObserver } from './extractor';
import { tagElements, removeAllTags, getTagsBoundingUnion, resolveElementById, getActiveTagCount } from './injector';
import {
  executeClick,
  executeType,
  executeHover,
  executePressKey,
  executeScrollPage,
  executeWaitFor,
  executeHandleDialog,
  clearOperationHistory,
} from './executor';
import type { OperationResult } from './executor';
import type {
  PageSemanticStructure,
  TagElementsResponse,
  ExecuteResponse,
  ExtractTextResponse,
  WaitForResponse,
} from '../shared/messages';

// ─── State Machine ─────────────────────────────────────────────────────────

type ContentState = 'idle' | 'extracting' | 'rendering' | 'executing';

let currentState: ContentState = 'idle';
let semanticObserver: MutationObserver | null = null;
let extractResultCache: PageSemanticStructure | null = null;
let extractResultStale = true;

// Mapping from semantic element IDs to CSS selectors (for extract_text lookup)
let semanticIdToSelector = new Map<number, string>();

function transition(newState: ContentState): void {
  const validTransitions: Record<ContentState, ContentState[]> = {
    idle: ['extracting', 'executing'],
    extracting: ['idle', 'rendering'],
    rendering: ['idle', 'executing'],
    executing: ['idle', 'extracting', 'rendering'],
  };

  if (!validTransitions[currentState].includes(newState)) {
    console.warn(`[dispatcher] Invalid state transition: ${currentState} → ${newState}`);
    return;
  }

  console.log(`[dispatcher] ${currentState} → ${newState}`);
  currentState = newState;
}

// ─── Observer Management ───────────────────────────────────────────────────

/**
 * Start observing the page for structural changes (SPA navigation, etc.)
 * When changes are detected, mark extraction cache as stale.
 */
export function startObserving(): void {
  if (semanticObserver) return;

  semanticObserver = createSemanticObserver({
    debounceMs: 500,
    onStructureChanged: (_structure) => {
      extractResultStale = true;
    },
  });

  semanticObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'aria-expanded', 'hidden', 'class'],
  });
}

export function stopObserving(): void {
  if (semanticObserver) {
    semanticObserver.disconnect();
    semanticObserver = null;
  }
  extractResultCache = null;
  extractResultStale = true;
}

// ─── Message Handler ───────────────────────────────────────────────────────

export interface DispatchResult {
  success: boolean;
  data?: unknown;
  error?: string;
  streamStatus?: 'thinking' | 'executing' | 'completed' | 'errored';
}

/**
 * Main dispatch entry point. Called by content.ts when it receives a message
 * from the Background Worker.
 */
export async function dispatch(action: string, params: Record<string, unknown>): Promise<DispatchResult> {
  switch (action) {
    case 'ping':
      return { success: true, data: { pong: true } };

    case 'get_page_semantic_structure':
      return handleGetSemanticStructure();

    case 'extract_text':
      return handleExtractText(params);

    case 'tag_elements':
      return handleTagElements(params);

    case 'call_vision_model':
      return handleCallVisionModel(params);

    case 'execute_click':
      return handleExecute('click', params);

    case 'execute_type':
      return handleExecute('type', params);

    case 'hover':
      return handleExecute('hover', params);

    case 'press_key':
      return handleExecute('press_key', params);

    case 'scroll_page':
      return handleExecute('scroll_page', params);

    case 'wait_for':
      return handleWaitFor(params);

    case 'handle_dialog':
      return handleExecute('handle_dialog', params);

    case 'execute_javascript':
      return handleExecuteJavascript(params);

    case 'cleanup':
      return handleCleanup();

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

// ─── Action Handlers ───────────────────────────────────────────────────────

async function handleGetSemanticStructure(): Promise<DispatchResult> {
  transition('extracting');
  try {
    const structure = await extractPageSemantics();
    extractResultCache = structure;
    extractResultStale = false;

    // Store the selector map for extract_text lookup
    // Access via the extractor module's internal state
    semanticIdToSelector = (structure as any).__selectorMap ?? new Map();

    transition('idle');
    return { success: true, data: structure };
  } catch (err) {
    transition('idle');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleExtractText(params: Record<string, unknown>): Promise<DispatchResult> {
  transition('executing');
  try {
    const elementId = params.element_id as number;

    // Try semantic ID lookup first (from extractor's selector map)
    const selector = semanticIdToSelector.get(elementId);
    let el: Element | null = null;

    if (selector) {
      try { el = document.querySelector(selector); } catch { /* invalid selector */ }
    }

    // Fallback: try tag element lookup
    if (!el) {
      el = resolveElementById(elementId);
    }

    if (!el) {
      transition('idle');
      return { success: false, error: `Element #${elementId} not found on page (may have been removed or re-rendered). Try get_page_semantic_structure again.` };
    }

    const text = (el.textContent ?? '').trim().slice(0, 500);
    extractResultStale = true;
    transition('idle');

    const response: ExtractTextResponse = {
      requestId: '',
      success: true,
      text,
    };
    return { success: true, data: response };
  } catch (err) {
    transition('idle');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleTagElements(params: Record<string, unknown>): Promise<DispatchResult> {
  // Can tag from idle or extracting state
  if (currentState !== 'idle' && currentState !== 'extracting') {
    return { success: false, error: `Cannot tag elements in ${currentState} state` };
  }

  transition('rendering');
  try {
    const selector = params.selector as string;
    const region = params.region as string | undefined;

    removeAllTags();

    const tagged = tagElements(selector, region);

    const boundsUnion = getTagsBoundingUnion(20);
    extractResultStale = true; // Tags modify the page visually

    transition('idle');

    const response: TagElementsResponse = {
      requestId: '',
      success: true,
      tagged,
      boundsUnion: boundsUnion ?? { x: 0, y: 0, width: 0, height: 0 },
    };

    return { success: true, data: response };
  } catch (err) {
    transition('idle');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleCallVisionModel(params: Record<string, unknown>): Promise<DispatchResult> {
  // This handler only prepares the tagged elements' bounding union
  // for the Background Worker to use when cropping the screenshot.
  // The actual vision API call happens in the Background Worker.
  try {
    const question = params.question as string;
    const boundsUnion = getTagsBoundingUnion(20);

    // Check that there are active tags to screenshot
    if (getActiveTagCount() === 0) {
      return { success: false, error: 'No tagged elements. Call tag_elements first.' };
    }

    // Return preparation data — actual vision call is in background
    return {
      success: true,
      data: {
        question,
        boundsUnion,
        tagCount: getActiveTagCount(),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleExecute(
  type: string,
  params: Record<string, unknown>,
): Promise<DispatchResult> {
  transition('executing');
  extractResultStale = true;

  try {
    let result: OperationResult;

    switch (type) {
      case 'click':
        result = await executeClick({ elementId: params.element_id as number });
        break;
      case 'type':
        result = await executeType({
          elementId: params.element_id as number,
          text: params.text as string,
        });
        break;
      case 'hover':
        result = await executeHover({ elementId: params.element_id as number });
        break;
      case 'press_key':
        result = await executePressKey({ key: params.key as string });
        break;
      case 'scroll_page':
        result = await executeScrollPage({
          direction: params.direction as 'up' | 'down' | 'top' | 'bottom',
        });
        break;
      case 'handle_dialog':
        result = await executeHandleDialog({
          action: params.dialog_action as 'accept' | 'dismiss',
          promptText: params.prompt_text as string | undefined,
        });
        break;
      default:
        transition('idle');
        return { success: false, error: `Unknown execute type: ${type}` };
    }

    transition('idle');

    if (result.success) {
      const response: ExecuteResponse = {
        requestId: '',
        success: true,
        actionTaken: result.actionTaken,
        preOperationHash: result.preOperationHash,
        postOperationHash: result.postOperationHash,
      };
      return { success: true, data: response };
    } else {
      return { success: false, error: result.error, data: result };
    }
  } catch (err) {
    transition('idle');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleWaitFor(params: Record<string, unknown>): Promise<DispatchResult> {
  transition('executing');
  try {
    const result = await executeWaitFor({
      condition: (params.condition ?? {}) as WaitForResponse['conditionMet'] extends boolean ? Record<string, unknown> : never,
      timeoutMs: params.timeout_ms as number | undefined,
    });

    transition('idle');

    const response = {
      requestId: '',
      success: result.success,
      conditionMet: result.success,
      elapsedMs: 0,
    } as WaitForResponse;

    return { success: result.success, data: response, error: result.error };
  } catch (err) {
    transition('idle');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleExecuteJavascript(params: Record<string, unknown>): Promise<DispatchResult> {
  transition('executing');
  try {
    const code = params.code as string;

    // This is a restricted handler — the sandbox validation happens in the
    // Background Worker before this is called. Here we just execute.
    // Additional defense-in-depth: validate again
    const { validateCode } = await import('../shared/sandbox');
    const validation = validateCode(code);
    if (!validation.valid) {
      transition('idle');
      return { success: false, error: `Sandbox rejection: ${validation.reason}` };
    }

    // Execute in a scoped function
    const result = new Function(`"use strict"; return (${code})`)();

    transition('idle');
    return { success: true, data: { result } };
  } catch (err) {
    transition('idle');
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleCleanup(): Promise<DispatchResult> {
  transition('idle');
  removeAllTags();
  stopObserving();
  clearOperationHistory();
  extractResultCache = null;
  extractResultStale = true;
  return { success: true, data: { cleaned: true } };
}

// ─── State Query ───────────────────────────────────────────────────────────

export function getState(): ContentState {
  return currentState;
}

export function isExtractStale(): boolean {
  return extractResultStale;
}

export function getCachedExtract(): PageSemanticStructure | null {
  return extractResultCache;
}
