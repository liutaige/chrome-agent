// ============================================================================
// Content Script Entry Point
//
// Injected at document_start. Handles:
//   1. Shadow DOM monkey-patch (force closed → open for accessibility)
//   2. Message listener (dispatches to extractor/injector/executor)
//   3. Lifecycle management (cleanup on navigation)
// ============================================================================

import { dispatch, startObserving, stopObserving } from './dispatcher';

// ─── Shadow DOM Monkey-Patch ───────────────────────────────────────────────
// Injected at document_start, before page scripts execute.
// Forces all attachShadow calls to use 'open' mode so our semantic extractor
// can traverse into Shadow DOM trees.
//
// Limitation: cross-origin iframe Shadow DOM remains inaccessible.
// This is documented in the plan — verification reports must note this.

const originalAttachShadow = Element.prototype.attachShadow;
let patchWarned = false;

Element.prototype.attachShadow = function (init: ShadowRootInit) {
  if (init.mode === 'closed') {
    if (!patchWarned) {
      console.log('[chrome-agent] Shadow DOM monkey-patch: forcing closed → open mode');
      patchWarned = true;
    }
    return originalAttachShadow.call(this, { ...init, mode: 'open' });
  }
  return originalAttachShadow.call(this, init);
};

// Also patch HTML element's attachShadow if present
if (typeof HTMLElement !== 'undefined' && HTMLElement.prototype.attachShadow) {
  HTMLElement.prototype.attachShadow = Element.prototype.attachShadow;
}

// ─── Message Listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Security: verify sender
  if (sender.id !== chrome.runtime.id) {
    console.error('[chrome-agent] Message from untrusted sender:', sender.id);
    sendResponse({ success: false, error: 'Untrusted sender' });
    return false;
  }

  // Validate basic structure
  if (!message || typeof message !== 'object' || !message.action) {
    sendResponse({ success: false, error: 'Invalid message format' });
    return false;
  }

  const { action, ...params } = message;

  // Handle the message asynchronously
  handleMessage(action, params).then((result) => {
    try {
      sendResponse(result);
    } catch {
      // Response channel may be closed (tab navigated away)
    }
  });

  // Return true to keep the message channel open for async response
  return true;
});

// ─── Message Handler ───────────────────────────────────────────────────────

async function handleMessage(
  action: string,
  params: Record<string, unknown>,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const result = await dispatch(action, params);
    return {
      success: result.success,
      data: result.data,
      error: result.error,
    };
  } catch (err) {
    console.error(`[chrome-agent] Error handling ${action}:`, err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

// Start observing the page for structural changes
if (document.body) {
  startObserving();
} else {
  // Body not available yet — wait for it
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      startObserving();
    }
  });
  observer.observe(document.documentElement, { childList: true });
}

// Listen for navigation events (SPA) — clear state
window.addEventListener('beforeunload', () => {
  stopObserving();
});

// Listen for pagehide (back/forward cache)
window.addEventListener('pagehide', () => {
  stopObserving();
});

// Re-start observation on pageshow (back from bfcache)
window.addEventListener('pageshow', () => {
  if (document.body) {
    startObserving();
  }
});

console.log('[chrome-agent] Content script loaded. Shadow DOM patch active.');
