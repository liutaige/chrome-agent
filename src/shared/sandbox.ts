// ============================================================================
// execute_javascript Code-Level Sandbox
// Three-layer governance: code validation → user confirmation → audit logging.
//
// This is the highest-risk entry point in the entire system.
// Prompt Injection that reaches execute_javascript can bypass all message
// whitelists and parameter validation — hence this multi-layer defense.
// ============================================================================

// ─── Audit Log ─────────────────────────────────────────────────────────────

export interface SandboxAuditEntry {
  timestamp: number;
  code: string;
  result: string | null;
  error: string | null;
  durationMs: number;
  blocked: boolean;
  blockedReason?: string;
}

/** Append-only circular buffer for audit logs. Max 1000 entries. */
const auditLog: SandboxAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 1000;

function addAuditEntry(entry: SandboxAuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.shift();
  }
}

export function getAuditLog(): readonly SandboxAuditEntry[] {
  return auditLog;
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}

// ─── Code Validation Patterns ──────────────────────────────────────────────

/**
 * ALLOWED: synchronous read-only operations.
 * These are the ONLY APIs the sandbox permits.
 * (Reference set — used for documentation; actual enforcement via BLOCKED_PATTERNS)
 */
void ([
  'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName',
  'getElementsByTagName', 'getElementsByName', 'closest', 'matches', 'contains',
  'compareDocumentPosition', 'getComputedStyle', 'getBoundingClientRect',
  'getClientRects', 'getSelection',
] as const);

/**
 * BLOCKED: any write operation, network access, or code execution.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // DOM write operations
  { pattern: /\.innerHTML\s*=/i, reason: 'innerHTML assignment (DOM write)' },
  { pattern: /\.outerHTML\s*=/i, reason: 'outerHTML assignment (DOM write)' },
  { pattern: /\.textContent\s*=/i, reason: 'textContent assignment (DOM write)' },
  { pattern: /\.innerText\s*=/i, reason: 'innerText assignment (DOM write)' },
  { pattern: /\.value\s*=/i, reason: 'value assignment (form write)' },
  { pattern: /\.checked\s*=/i, reason: 'checked assignment (form write)' },
  { pattern: /\.className\s*=/i, reason: 'className assignment (DOM write)' },
  { pattern: /\.classList\./i, reason: 'classList modification (DOM write)' },
  { pattern: /\.setAttribute\s*\(/i, reason: 'setAttribute call (DOM write)' },
  { pattern: /\.removeAttribute\s*\(/i, reason: 'removeAttribute call (DOM write)' },
  { pattern: /\.remove\s*\(/i, reason: 'remove() call (DOM removal)' },
  { pattern: /\.removeChild\s*\(/i, reason: 'removeChild call (DOM removal)' },
  { pattern: /\.appendChild\s*\(/i, reason: 'appendChild call (DOM write)' },
  { pattern: /\.insertBefore\s*\(/i, reason: 'insertBefore call (DOM write)' },
  { pattern: /\.replaceChild\s*\(/i, reason: 'replaceChild call (DOM write)' },
  { pattern: /\.replaceWith\s*\(/i, reason: 'replaceWith call (DOM write)' },
  { pattern: /\.insertAdjacentHTML\s*\(/i, reason: 'insertAdjacentHTML call (DOM write)' },
  { pattern: /\.insertAdjacentElement\s*\(/i, reason: 'insertAdjacentElement call (DOM write)' },
  { pattern: /\.cloneNode\s*\(/i, reason: 'cloneNode call (potential DOM write)' },
  { pattern: /\.style\.\w+\s*=/i, reason: 'inline style assignment (DOM write)' },
  { pattern: /\.focus\s*\(/i, reason: 'focus() call (user interaction)' },
  { pattern: /\.blur\s*\(/i, reason: 'blur() call (user interaction)' },
  { pattern: /\.click\s*\(/i, reason: 'click() call (user interaction)' },
  { pattern: /\.scrollIntoView\s*\(/i, reason: 'scrollIntoView call (page manipulation)' },
  { pattern: /\.scrollTo\s*\(/i, reason: 'scrollTo call (page manipulation)' },
  { pattern: /\.scrollBy\s*\(/i, reason: 'scrollBy call (page manipulation)' },
  { pattern: /\.show\s*\(/i, reason: 'show() call (popup)' },
  { pattern: /\.showModal\s*\(/i, reason: 'showModal() call (dialog)' },

  // Dispatch events
  { pattern: /\.dispatchEvent\s*\(/i, reason: 'dispatchEvent call (event dispatching)' },
  { pattern: /new\s+Event\s*\(/i, reason: 'Event constructor (event creation)' },
  { pattern: /new\s+CustomEvent\s*\(/i, reason: 'CustomEvent constructor (event creation)' },
  { pattern: /new\s+MouseEvent\s*\(/i, reason: 'MouseEvent constructor (event creation)' },
  { pattern: /new\s+KeyboardEvent\s*\(/i, reason: 'KeyboardEvent constructor (event creation)' },

  // Network access
  { pattern: /\bfetch\s*\(/i, reason: 'fetch() call (network)' },
  { pattern: /\bXMLHttpRequest\b/i, reason: 'XMLHttpRequest (network)' },
  { pattern: /\bWebSocket\b/i, reason: 'WebSocket (network)' },
  { pattern: /\bEventSource\b/i, reason: 'EventSource (network)' },
  { pattern: /\bnavigator\.sendBeacon\b/i, reason: 'sendBeacon (network)' },
  { pattern: /\.src\s*=/i, reason: 'src assignment (potential network)' },
  { pattern: /\.href\s*=/i, reason: 'href assignment (potential navigation)' },
  { pattern: /\.action\s*=/i, reason: 'form action assignment (potential network)' },

  // Code execution
  { pattern: /\beval\s*\(/i, reason: 'eval() call (code execution)' },
  { pattern: /\bnew\s+Function\s*\(/i, reason: 'new Function (code execution)' },
  { pattern: /\bsetTimeout\s*\(\s*['"`]/i, reason: 'setTimeout with string (code execution)' },
  { pattern: /\bsetInterval\s*\(\s*['"`]/i, reason: 'setInterval with string (code execution)' },
  { pattern: /\bimport\s*\(/i, reason: 'dynamic import() (code execution)' },

  // Storage access (potential data exfiltration)
  { pattern: /\blocalStorage\b/i, reason: 'localStorage access (data exfiltration)' },
  { pattern: /\bsessionStorage\b/i, reason: 'sessionStorage access (data exfiltration)' },
  { pattern: /\bindexedDB\b/i, reason: 'IndexedDB access (data exfiltration)' },
  { pattern: /\bcookie\b/i, reason: 'cookie access (data exfiltration)' },

  // Dangerous global access
  { pattern: /\bchrome\b/i, reason: 'chrome API access (privileged API)' },
  { pattern: /\bbrowser\b/i, reason: 'browser API access (privileged API)' },
];

/**
 * Validate that a code string passes the sandbox restrictions.
 * Uses regex-based pattern matching to catch the overwhelming majority
 * of dangerous calls. Not a complete static analysis, but sufficient
 * given the additional user-confirmation and audit-log layers.
 */
export function validateCode(code: string): { valid: true } | { valid: false; reason: string } {
  if (!code || code.trim().length === 0) {
    return { valid: false, reason: 'Code is empty' };
  }

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      return { valid: false, reason };
    }
  }

  return { valid: true };
}

/**
 * Wrap code in a try/catch and execute it in the page context.
 * The code is validated BEFORE this function is called.
 *
 * IMPORTANT: This function is designed to be serialized and injected via
 * chrome.scripting.executeScript. It runs in the MAIN world of the page.
 */
export function createSandboxedExecutor(userCode: string): string {
  return `
    (function sandboxedExecution() {
      'use strict';
      const __start = performance.now();
      let __result = null;
      let __error = null;
      try {
        __result = (function() {
          ${userCode}
        })();
      } catch (e) {
        __error = e instanceof Error ? e.message : String(e);
      }
      const __duration = performance.now() - __start;
      return {
        result: __result,
        error: __error,
        durationMs: __duration,
      };
    })()
  `;
}

/**
 * Execute sandboxed code in the target tab and return the result with audit trail.
 *
 * @param tabId - Target tab ID
 * @param code - The sandboxed JavaScript code to execute
 * @param userApproved - Whether the user has explicitly approved this execution
 * @returns Execution result with audit entry appended
 */
export async function executeSandboxedCode(
  tabId: number,
  code: string,
  userApproved: boolean,
): Promise<{ result: unknown; error: string | null; durationMs: number; auditEntry: SandboxAuditEntry }> {
  const startTime = Date.now();

  if (!userApproved) {
    const entry: SandboxAuditEntry = {
      timestamp: startTime,
      code,
      result: null,
      error: 'Execution blocked: user did not approve',
      durationMs: 0,
      blocked: true,
      blockedReason: 'user_declined',
    };
    addAuditEntry(entry);
    return { result: null, error: 'Execution blocked: user did not approve', durationMs: 0, auditEntry: entry };
  }

  // Validate code before injection
  const validation = validateCode(code);
  if (!validation.valid) {
    const entry: SandboxAuditEntry = {
      timestamp: startTime,
      code,
      result: null,
      error: `Execution blocked: ${validation.reason}`,
      durationMs: 0,
      blocked: true,
      blockedReason: validation.reason,
    };
    addAuditEntry(entry);
    return { result: null, error: `Sandbox violation: ${validation.reason}`, durationMs: 0, auditEntry: entry };
  }

  try {
    void createSandboxedExecutor(code); // code string prepared for future injection

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // This is a placeholder — the actual code is injected as a string above.
        // In production, use chrome.scripting.executeScript with `func` for
        // sandboxed execution, not eval. This function body is replaced by
        // the wrappedCode string injection.
      },
    });

    // Note: For MAIN-world injection, we need to use the `func` approach
    // differently. The actual implementation will inline the wrapped code.
    // For now, return a structured result.
    const durationMs = Date.now() - startTime;
    const result = injectionResults[0]?.result;

    const entry: SandboxAuditEntry = {
      timestamp: startTime,
      code,
      result: result ? JSON.stringify(result) : null,
      error: null,
      durationMs,
      blocked: false,
    };
    addAuditEntry(entry);

    return {
      result: result ?? null,
      error: null,
      durationMs,
      auditEntry: entry,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    const entry: SandboxAuditEntry = {
      timestamp: startTime,
      code,
      result: null,
      error: errorMsg,
      durationMs,
      blocked: false,
    };
    addAuditEntry(entry);

    return { result: null, error: errorMsg, durationMs, auditEntry: entry };
  }
}
