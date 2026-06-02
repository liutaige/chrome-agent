var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/shared/sandbox.ts
var sandbox_exports = {};
__export(sandbox_exports, {
  clearAuditLog: () => clearAuditLog,
  createSandboxedExecutor: () => createSandboxedExecutor,
  executeSandboxedCode: () => executeSandboxedCode,
  getAuditLog: () => getAuditLog,
  validateCode: () => validateCode
});
function addAuditEntry(entry) {
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.shift();
  }
}
function getAuditLog() {
  return auditLog;
}
function clearAuditLog() {
  auditLog.length = 0;
}
function validateCode(code) {
  if (!code || code.trim().length === 0) {
    return { valid: false, reason: "Code is empty" };
  }
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(code)) {
      return { valid: false, reason };
    }
  }
  return { valid: true };
}
function createSandboxedExecutor(userCode) {
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
async function executeSandboxedCode(tabId, code, userApproved) {
  const startTime = Date.now();
  if (!userApproved) {
    const entry = {
      timestamp: startTime,
      code,
      result: null,
      error: "Execution blocked: user did not approve",
      durationMs: 0,
      blocked: true,
      blockedReason: "user_declined"
    };
    addAuditEntry(entry);
    return { result: null, error: "Execution blocked: user did not approve", durationMs: 0, auditEntry: entry };
  }
  const validation = validateCode(code);
  if (!validation.valid) {
    const entry = {
      timestamp: startTime,
      code,
      result: null,
      error: `Execution blocked: ${validation.reason}`,
      durationMs: 0,
      blocked: true,
      blockedReason: validation.reason
    };
    addAuditEntry(entry);
    return { result: null, error: `Sandbox violation: ${validation.reason}`, durationMs: 0, auditEntry: entry };
  }
  try {
    void createSandboxedExecutor(code);
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
      }
    });
    const durationMs = Date.now() - startTime;
    const result = injectionResults[0]?.result;
    const entry = {
      timestamp: startTime,
      code,
      result: result ? JSON.stringify(result) : null,
      error: null,
      durationMs,
      blocked: false
    };
    addAuditEntry(entry);
    return {
      result: result ?? null,
      error: null,
      durationMs,
      auditEntry: entry
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    const entry = {
      timestamp: startTime,
      code,
      result: null,
      error: errorMsg,
      durationMs,
      blocked: false
    };
    addAuditEntry(entry);
    return { result: null, error: errorMsg, durationMs, auditEntry: entry };
  }
}
var auditLog, MAX_AUDIT_ENTRIES, BLOCKED_PATTERNS;
var init_sandbox = __esm({
  "src/shared/sandbox.ts"() {
    "use strict";
    auditLog = [];
    MAX_AUDIT_ENTRIES = 1e3;
    BLOCKED_PATTERNS = [
      // DOM write operations
      { pattern: /\.innerHTML\s*=/i, reason: "innerHTML assignment (DOM write)" },
      { pattern: /\.outerHTML\s*=/i, reason: "outerHTML assignment (DOM write)" },
      { pattern: /\.textContent\s*=/i, reason: "textContent assignment (DOM write)" },
      { pattern: /\.innerText\s*=/i, reason: "innerText assignment (DOM write)" },
      { pattern: /\.value\s*=/i, reason: "value assignment (form write)" },
      { pattern: /\.checked\s*=/i, reason: "checked assignment (form write)" },
      { pattern: /\.className\s*=/i, reason: "className assignment (DOM write)" },
      { pattern: /\.classList\./i, reason: "classList modification (DOM write)" },
      { pattern: /\.setAttribute\s*\(/i, reason: "setAttribute call (DOM write)" },
      { pattern: /\.removeAttribute\s*\(/i, reason: "removeAttribute call (DOM write)" },
      { pattern: /\.remove\s*\(/i, reason: "remove() call (DOM removal)" },
      { pattern: /\.removeChild\s*\(/i, reason: "removeChild call (DOM removal)" },
      { pattern: /\.appendChild\s*\(/i, reason: "appendChild call (DOM write)" },
      { pattern: /\.insertBefore\s*\(/i, reason: "insertBefore call (DOM write)" },
      { pattern: /\.replaceChild\s*\(/i, reason: "replaceChild call (DOM write)" },
      { pattern: /\.replaceWith\s*\(/i, reason: "replaceWith call (DOM write)" },
      { pattern: /\.insertAdjacentHTML\s*\(/i, reason: "insertAdjacentHTML call (DOM write)" },
      { pattern: /\.insertAdjacentElement\s*\(/i, reason: "insertAdjacentElement call (DOM write)" },
      { pattern: /\.cloneNode\s*\(/i, reason: "cloneNode call (potential DOM write)" },
      { pattern: /\.style\.\w+\s*=/i, reason: "inline style assignment (DOM write)" },
      { pattern: /\.focus\s*\(/i, reason: "focus() call (user interaction)" },
      { pattern: /\.blur\s*\(/i, reason: "blur() call (user interaction)" },
      { pattern: /\.click\s*\(/i, reason: "click() call (user interaction)" },
      { pattern: /\.scrollIntoView\s*\(/i, reason: "scrollIntoView call (page manipulation)" },
      { pattern: /\.scrollTo\s*\(/i, reason: "scrollTo call (page manipulation)" },
      { pattern: /\.scrollBy\s*\(/i, reason: "scrollBy call (page manipulation)" },
      { pattern: /\.show\s*\(/i, reason: "show() call (popup)" },
      { pattern: /\.showModal\s*\(/i, reason: "showModal() call (dialog)" },
      // Dispatch events
      { pattern: /\.dispatchEvent\s*\(/i, reason: "dispatchEvent call (event dispatching)" },
      { pattern: /new\s+Event\s*\(/i, reason: "Event constructor (event creation)" },
      { pattern: /new\s+CustomEvent\s*\(/i, reason: "CustomEvent constructor (event creation)" },
      { pattern: /new\s+MouseEvent\s*\(/i, reason: "MouseEvent constructor (event creation)" },
      { pattern: /new\s+KeyboardEvent\s*\(/i, reason: "KeyboardEvent constructor (event creation)" },
      // Network access
      { pattern: /\bfetch\s*\(/i, reason: "fetch() call (network)" },
      { pattern: /\bXMLHttpRequest\b/i, reason: "XMLHttpRequest (network)" },
      { pattern: /\bWebSocket\b/i, reason: "WebSocket (network)" },
      { pattern: /\bEventSource\b/i, reason: "EventSource (network)" },
      { pattern: /\bnavigator\.sendBeacon\b/i, reason: "sendBeacon (network)" },
      { pattern: /\.src\s*=/i, reason: "src assignment (potential network)" },
      { pattern: /\.href\s*=/i, reason: "href assignment (potential navigation)" },
      { pattern: /\.action\s*=/i, reason: "form action assignment (potential network)" },
      // Code execution
      { pattern: /\beval\s*\(/i, reason: "eval() call (code execution)" },
      { pattern: /\bnew\s+Function\s*\(/i, reason: "new Function (code execution)" },
      { pattern: /\bsetTimeout\s*\(\s*['"`]/i, reason: "setTimeout with string (code execution)" },
      { pattern: /\bsetInterval\s*\(\s*['"`]/i, reason: "setInterval with string (code execution)" },
      { pattern: /\bimport\s*\(/i, reason: "dynamic import() (code execution)" },
      // Storage access (potential data exfiltration)
      { pattern: /\blocalStorage\b/i, reason: "localStorage access (data exfiltration)" },
      { pattern: /\bsessionStorage\b/i, reason: "sessionStorage access (data exfiltration)" },
      { pattern: /\bindexedDB\b/i, reason: "IndexedDB access (data exfiltration)" },
      { pattern: /\bcookie\b/i, reason: "cookie access (data exfiltration)" },
      // Dangerous global access
      { pattern: /\bchrome\b/i, reason: "chrome API access (privileged API)" },
      { pattern: /\bbrowser\b/i, reason: "browser API access (privileged API)" }
    ];
  }
});

// src/content/filter.ts
var PII_PATTERNS = [
  // Email addresses
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[email]" },
  // Chinese mobile phone numbers
  { pattern: /1[3-9]\d{9}/g, replacement: "[phone]" },
  // 13-19 digit consecutive numbers (credit card / account number patterns)
  { pattern: /\b\d{13,19}\b/g, replacement: "[card-number]" }
];
var SECURITY_NAME_PATTERN = /token|nonce|csrf|session|auth|key|secret|password|verification|credential|__/i;
var EXCLUDED_INPUT_TYPES = /* @__PURE__ */ new Set(["hidden", "password", "file"]);
function filterSensitiveInputType(type) {
  if (!type) return true;
  return !EXCLUDED_INPUT_TYPES.has(type.toLowerCase());
}
function filterSecurityName(name) {
  if (SECURITY_NAME_PATTERN.test(name)) {
    return "[filtered]";
  }
  return name;
}
function sanitizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    const qIdx = url.indexOf("?");
    const fIdx = url.indexOf("#");
    let end = url.length;
    if (qIdx >= 0) end = Math.min(end, qIdx);
    if (fIdx >= 0) end = Math.min(end, fIdx);
    return url.slice(0, end);
  }
}
function removePII(text) {
  let result = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
function truncateText(text, maxChars = 8e3) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const truncated = normalized.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.8) {
    return truncated.slice(0, lastSpace) + "\u2026";
  }
  return truncated + "\u2026";
}
function filterInputElement(_tagName, type, name, placeholder, ariaLabel) {
  if (!filterSensitiveInputType(type)) {
    return { include: false };
  }
  const sanitizedName = name ? filterSecurityName(name) : void 0;
  const sanitizedPlaceholder = placeholder ? removePII(truncateText(placeholder, 200)) : void 0;
  const sanitizedAriaLabel = ariaLabel ? removePII(truncateText(ariaLabel, 200)) : void 0;
  return {
    include: true,
    name: sanitizedName,
    type: type ?? void 0,
    placeholder: sanitizedPlaceholder,
    ariaLabel: sanitizedAriaLabel
  };
}
function filterTextContent(text, maxChars = 200) {
  const piiFree = removePII(text);
  return truncateText(piiFree, maxChars);
}
function filterHref(href) {
  if (!href) return void 0;
  return sanitizeUrl(href);
}
function filterAttributeName(name) {
  return filterSecurityName(name);
}
var TOKEN_BUDGET = {
  title: 500,
  // chars
  nav: 800,
  // chars
  forms: 2e3,
  // chars
  interactiveElements: 3e3,
  // chars
  structuralAreas: 1200,
  // chars
  other: 500
  // chars
};
function enforceTokenBudget(structure) {
  return {
    title: truncateText(structure.title, TOKEN_BUDGET.title),
    navItems: structure.navItems.map((n) => truncateText(n, 100)),
    formText: truncateText(structure.formText, TOKEN_BUDGET.forms),
    interactiveText: truncateText(structure.interactiveText, TOKEN_BUDGET.interactiveElements),
    structuralText: truncateText(structure.structuralText, TOKEN_BUDGET.structuralAreas)
  };
}
function isInViewport(el, viewportHeight) {
  const rect = el.getBoundingClientRect();
  const topMargin = 200;
  return rect.bottom >= -topMargin && rect.top <= viewportHeight + topMargin;
}
function isElementVisible(el) {
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) > 0 && !el.hasAttribute("aria-hidden") && // Check if element has dimensions
  el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
}

// src/content/extractor.ts
var MAX_INTERACTIVE_ELEMENTS = 200;
var MAX_TREE_DEPTH = 15;
var YIELD_EVERY_N = 50;
var EXTRACTION_TIMEOUT_MS = 1e3;
var LARGE_PAGE_THRESHOLD = 5e3;
var INTERACTIVE_SELECTORS = [
  "a[href]",
  "button",
  'input:not([type="hidden"]):not([type="password"])',
  "select",
  "textarea",
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  "[onclick]",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  "details > summary"
];
var NAV_SELECTORS = [
  "nav",
  '[role="navigation"]',
  "header",
  ".nav",
  ".navbar",
  ".navigation",
  ".menu",
  "#nav",
  "#navbar",
  "#navigation",
  "#menu"
];
var FORM_SELECTORS = [
  "form",
  '[role="form"]',
  '[role="search"]',
  ".search",
  "#search"
];
var STRUCTURAL_SELECTORS = [
  '[role="list"]',
  '[role="listbox"]',
  '[role="grid"]',
  '[role="article"]',
  "ul",
  "ol",
  "table",
  ".card",
  ".result",
  ".item",
  "[data-result]",
  ".search-result"
];
function yieldToEventLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
function textFingerprint(text) {
  return text.slice(0, 50).toLowerCase().trim();
}
function isTimedOut(state) {
  if (state.timedOut) return true;
  if (performance.now() - state.startTime > EXTRACTION_TIMEOUT_MS) {
    state.timedOut = true;
    return true;
  }
  return false;
}
async function extractPageSemantics() {
  const startTime = performance.now();
  const totalElements = document.querySelectorAll("*").length;
  const mode = totalElements > LARGE_PAGE_THRESHOLD ? "viewport" : "full_page";
  const state = {
    interactiveElements: [],
    interactiveCount: 0,
    forms: [],
    navItems: [],
    structuralAreas: [],
    seenText: /* @__PURE__ */ new Set(),
    elementIdCounter: 0,
    startTime,
    timedOut: false,
    mode,
    selectorMap: /* @__PURE__ */ new Map()
  };
  extractTitle(state);
  extractNavigation(state);
  await extractInteractiveElements(state);
  extractForms(state);
  extractStructuralAreas(state);
  const durationMs = performance.now() - startTime;
  const truncated = state.timedOut || state.interactiveCount >= MAX_INTERACTIVE_ELEMENTS;
  const structure = enforceTokenBudget({
    title: document.title,
    navItems: state.navItems,
    formText: state.forms.map((f) => f.region + ": " + f.fields.map((fd) => fd.label).join(", ")).join(" | "),
    interactiveText: state.interactiveElements.map((el) => el.text + (el.placeholder ? ` (${el.placeholder})` : "")).join(" | "),
    structuralText: state.structuralAreas.map((a) => a.sampleText).join(" | ")
  });
  const result = {
    title: structure.title,
    url: sanitizeUrl(window.location.href),
    mainNav: structure.navItems,
    forms: state.forms.map((f) => ({
      region: f.region,
      fields: f.fields.map((fd) => ({
        label: fd.label,
        placeholder: fd.placeholder,
        name: fd.name,
        type: fd.type,
        required: fd.required
      }))
    })),
    interactiveElements: state.interactiveElements.slice(0, MAX_INTERACTIVE_ELEMENTS),
    structuralAreas: state.structuralAreas,
    // Attach selector map for extract_text lookup (not part of the public API)
    __selectorMap: state.selectorMap,
    extractionMetadata: {
      mode,
      totalElements,
      interactiveCount: state.interactiveElements.length,
      durationMs: Math.round(durationMs),
      truncated
    }
  };
  return result;
}
function extractTitle(state) {
  void state;
}
function extractNavigation(state) {
  const navContainers = [];
  for (const selector of NAV_SELECTORS) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (isElementVisible(el)) {
          navContainers.push(el);
        }
      }
      if (navContainers.length > 0) break;
    } catch {
    }
  }
  if (navContainers.length === 0) return;
  const nav = navContainers[0];
  const links = nav.querySelectorAll("a[href]");
  for (const link of links) {
    if (state.navItems.length >= 20) break;
    if (!isElementVisible(link)) continue;
    const text = filterTextContent(link.textContent ?? "", 60);
    if (text && !state.seenText.has(textFingerprint(text))) {
      state.seenText.add(textFingerprint(text));
      state.navItems.push(text);
    }
  }
}
async function extractInteractiveElements(state) {
  const viewportHeight = window.innerHeight;
  let processedSinceYield = 0;
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (isTimedOut(state)) return NodeFilter.FILTER_REJECT;
        if (state.interactiveCount >= MAX_INTERACTIVE_ELEMENTS) return NodeFilter.FILTER_REJECT;
        const el = node;
        const tagDepth = computeDepth(el);
        if (tagDepth > MAX_TREE_DEPTH) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  let currentNode = walker.nextNode();
  const interactiveSelectorStr = INTERACTIVE_SELECTORS.join(",");
  while (currentNode && state.interactiveCount < MAX_INTERACTIVE_ELEMENTS && !isTimedOut(state)) {
    const el = currentNode;
    if (matchesInteractive(el, interactiveSelectorStr)) {
      if (state.mode === "viewport" && !isInViewport(el, viewportHeight)) {
        currentNode = walker.nextNode();
        continue;
      }
      if (!isElementVisible(el)) {
        currentNode = walker.nextNode();
        continue;
      }
      const interactiveEl = extractInteractiveElement(el, state);
      if (interactiveEl) {
        state.interactiveElements.push(interactiveEl);
        state.interactiveCount++;
        processedSinceYield++;
      }
    }
    if (processedSinceYield >= YIELD_EVERY_N) {
      processedSinceYield = 0;
      await yieldToEventLoop();
    }
    currentNode = walker.nextNode();
  }
}
function extractForms(state) {
  for (const selector of FORM_SELECTORS) {
    try {
      const containers = document.querySelectorAll(selector);
      for (const container of containers) {
        if (!isElementVisible(container)) continue;
        if (isTimedOut(state)) return;
        const form = {
          region: getFormRegionName(container),
          fields: []
        };
        const inputs = container.querySelectorAll('input, select, textarea, [role="combobox"], [role="listbox"]');
        for (const input of inputs) {
          if (form.fields.length >= 10) break;
          if (!isElementVisible(input)) continue;
          const field = extractFormField(input);
          if (field) {
            form.fields.push(field);
          }
        }
        if (form.fields.length > 0) {
          state.forms.push(form);
        }
      }
    } catch {
    }
  }
  if (state.forms.length === 0) {
    const standaloneInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="password"])[id], textarea[id], select[id]');
    const standaloneFields = [];
    for (const input of standaloneInputs) {
      if (standaloneFields.length >= 10) break;
      if (!isElementVisible(input)) continue;
      const field = extractFormField(input);
      if (field) {
        standaloneFields.push(field);
      }
    }
    if (standaloneFields.length > 0) {
      state.forms.push({
        region: "page",
        fields: standaloneFields
      });
    }
  }
}
function extractStructuralAreas(state) {
  for (const selector of STRUCTURAL_SELECTORS) {
    if (state.structuralAreas.length >= 5) break;
    if (isTimedOut(state)) return;
    try {
      const containers = document.querySelectorAll(selector);
      for (const container of containers) {
        if (state.structuralAreas.length >= 5) break;
        if (!isElementVisible(container)) continue;
        const area = classifyStructuralArea(container);
        if (area) {
          state.structuralAreas.push(area);
        }
      }
    } catch {
    }
  }
}
function matchesInteractive(el, selectorStr) {
  try {
    return el.matches(selectorStr);
  } catch {
    return false;
  }
}
function computeDepth(el) {
  let depth = 0;
  let current = el;
  while (current && current !== document.documentElement) {
    depth++;
    current = current.parentElement;
  }
  return depth;
}
function extractInteractiveElement(el, state) {
  const tagName = el.tagName.toLowerCase();
  const text = filterTextContent(el.textContent ?? "", 200);
  const fp = textFingerprint(text);
  if (fp && state.seenText.has(fp)) return null;
  if (fp) state.seenText.add(fp);
  const id = ++state.elementIdCounter;
  const selector = buildUniqueSelector(el);
  state.selectorMap.set(id, selector);
  const element = {
    id,
    tagName,
    text,
    type: el.type || void 0,
    role: el.getAttribute("role") || void 0,
    ariaLabel: el.getAttribute("aria-label")?.slice(0, 200) || void 0,
    href: filterHref(el.getAttribute("href")),
    placeholder: el.placeholder?.slice(0, 200) || void 0,
    visible: isElementVisible(el)
  };
  return element;
}
function buildUniqueSelector(el) {
  const tag = el.tagName.toLowerCase();
  const id = el.id;
  if (id) return `#${CSS.escape(id)}`;
  const type = el.getAttribute("type");
  const name = el.getAttribute("name");
  const role = el.getAttribute("role");
  const ariaLabel = el.getAttribute("aria-label");
  const placeholder = el.placeholder;
  if (type && name) return `${tag}[type="${CSS.escape(type)}"][name="${CSS.escape(name)}"]`;
  if (type && placeholder) return `${tag}[type="${CSS.escape(type)}"][placeholder="${CSS.escape(placeholder)}"]`;
  if (name) return `${tag}[name="${CSS.escape(name)}"]`;
  if (role) return `${tag}[role="${CSS.escape(role)}"]`;
  if (ariaLabel) return `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
  if (type) return `${tag}[type="${CSS.escape(type)}"]`;
  const parts = [tag];
  let child = el;
  let parent = el.parentElement;
  while (parent && parent !== document.body && parts.length < 5) {
    const siblings = Array.from(parent.children);
    const idx = siblings.indexOf(child) + 1;
    parts.unshift(`> :nth-child(${idx})`);
    child = parent;
    parent = parent.parentElement;
  }
  return "body " + parts.join(" ");
}
function extractFormField(el) {
  const tagName = el.tagName.toLowerCase();
  const type = el.type || tagName;
  const filterResult = filterInputElement(
    tagName,
    type,
    el.getAttribute("name"),
    el.placeholder,
    el.getAttribute("aria-label")
  );
  if (!filterResult.include) return null;
  let label = "";
  const id = el.getAttribute("id");
  if (id) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (labelEl) {
      label = filterTextContent(labelEl.textContent ?? "", 100);
    }
  }
  if (!label) {
    const parentLabel = el.closest("label");
    if (parentLabel) {
      label = filterTextContent(parentLabel.textContent ?? "", 100);
    }
  }
  if (!label) {
    label = filterResult.placeholder ?? filterResult.ariaLabel ?? "";
  }
  return {
    label: filterTextContent(label, 100),
    placeholder: filterResult.placeholder,
    name: filterResult.name ? filterAttributeName(filterResult.name) : void 0,
    type: filterResult.type ?? type,
    required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true"
  };
}
function getFormRegionName(container) {
  const heading = container.querySelector("h1, h2, h3, h4, legend");
  if (heading && heading.textContent) {
    return filterTextContent(heading.textContent, 50);
  }
  const ariaLabel = container.getAttribute("aria-label");
  if (ariaLabel) return filterTextContent(ariaLabel, 50);
  const role = container.getAttribute("role");
  if (role === "search") return "search";
  const className = container.className?.toString() ?? "";
  const id = container.id ?? "";
  if (className.includes("search") || id.includes("search")) return "search";
  if (className.includes("login") || id.includes("login")) return "login";
  if (className.includes("register") || id.includes("register")) return "register";
  if (className.includes("contact") || id.includes("contact")) return "contact";
  return "form";
}
function classifyStructuralArea(container) {
  const role = container.getAttribute("role");
  const tagName = container.tagName.toLowerCase();
  let type = "other";
  if (role === "list" || role === "listbox" || tagName === "ul" || tagName === "ol") {
    type = "list";
  } else if (role === "article" || container.matches('.card, .result-card, [class*="card"]')) {
    type = "card";
  } else if (container.matches('.search-result, [class*="search-result"], [class*="searchResult"]')) {
    type = "search_result";
  } else if (role === "navigation" || tagName === "nav") {
    type = "navigation";
  }
  const items = container.querySelectorAll(':scope > li, :scope > [role="listitem"], :scope > [role="option"], :scope > .item, :scope > .card, :scope > .result, :scope > tr');
  const count = items.length || container.children.length;
  const sampleText = filterTextContent(container.textContent ?? "", 200);
  return {
    type,
    count: count > 1 ? count : void 0,
    sampleText
  };
}
function createSemanticObserver(config) {
  let debounceTimer = null;
  let pending = false;
  const observer = new MutationObserver((mutations) => {
    const hasStructuralChange = mutations.some((m) => {
      if (m.type === "childList" && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
        return Array.from(m.addedNodes).some((n) => n.nodeType === Node.ELEMENT_NODE) || Array.from(m.removedNodes).some((n) => n.nodeType === Node.ELEMENT_NODE);
      }
      return false;
    });
    if (!hasStructuralChange) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (!pending) {
      pending = true;
      debounceTimer = setTimeout(async () => {
        pending = false;
        debounceTimer = null;
        const structure = await extractPageSemantics();
        config.onStructureChanged(structure);
      }, config.debounceMs);
    }
  });
  return observer;
}

// src/content/injector.ts
var MAX_TAGS = 10;
var DEFAULT_TAG_TTL_MS = 3e4;
var Z_INDEX_FLOOR = 2147483647;
var activeTags = /* @__PURE__ */ new Map();
var shadowRoot = null;
var tagContainer = null;
var syncRafId = null;
var mutationObserver = null;
function tagElements(selector, region, ttlMs = DEFAULT_TAG_TTL_MS) {
  removeAllTags();
  const candidates = findCandidates(selector, region);
  const toTag = candidates.slice(0, MAX_TAGS);
  ensureTagContainer();
  const tagged = [];
  let idCounter = 1;
  for (const el of toTag) {
    const id = idCounter++;
    const locators = buildMultiStrategyLocator(el, id);
    const boundingRect = getElementBounds(el);
    const tagEl = createTagElement(id, boundingRect);
    el.setAttribute("data-tag-id", `@${id}`);
    tagContainer.appendChild(tagEl);
    const tag = {
      id,
      element: el,
      tagEl,
      locators,
      ttlMs,
      createdAt: performance.now(),
      fingerprint: computeFingerprint(el)
    };
    activeTags.set(id, tag);
    tagged.push({
      id,
      tagName: el.tagName.toLowerCase(),
      text: (el.textContent ?? "").trim().slice(0, 100),
      boundingRect,
      locators
    });
  }
  startPositionSync();
  observeTagIntegrity();
  return tagged;
}
function removeAllTags() {
  stopPositionSync();
  stopTagIntegrityObserver();
  for (const [, tag] of activeTags) {
    tag.element.removeAttribute("data-tag-id");
    if (tag.tagEl.parentElement) {
      tag.tagEl.remove();
    }
  }
  activeTags.clear();
  if (tagContainer) {
    tagContainer.remove();
    tagContainer = null;
    shadowRoot = null;
  }
}
function getTagsBoundingUnion(margin = 20) {
  if (activeTags.size === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, tag] of activeTags) {
    const rect = tag.element.getBoundingClientRect();
    minX = Math.min(minX, rect.left);
    minY = Math.min(minY, rect.top + window.scrollY);
    maxX = Math.max(maxX, rect.right);
    maxY = Math.max(maxY, rect.bottom + window.scrollY);
  }
  return {
    x: Math.max(0, minX - margin),
    y: Math.max(0, minY - margin),
    width: maxX - minX + margin * 2,
    height: maxY - minY + margin * 2
  };
}
function resolveElementById(id) {
  const tag = activeTags.get(id);
  if (!tag) return null;
  if (tag.element.isConnected && tag.element.hasAttribute("data-tag-id")) {
    const attr = tag.element.getAttribute("data-tag-id");
    if (attr === `@${id}`) return tag.element;
  }
  const byDataTag = document.querySelector(`[data-tag-id="@${id}"]`);
  if (byDataTag) return byDataTag;
  try {
    const byCssPath = document.querySelector(tag.locators.cssPath);
    if (byCssPath) return byCssPath;
  } catch {
  }
  try {
    const byAttr = document.querySelector(tag.locators.attributeSelector);
    if (byAttr) return byAttr;
  } catch {
  }
  const byText = findElementByTextFragment(tag.element.tagName.toLowerCase(), tag.locators.textFragment);
  if (byText) return byText;
  return null;
}
function isElementStillValid(id) {
  const tag = activeTags.get(id);
  if (!tag) return false;
  if (performance.now() - tag.createdAt > tag.ttlMs) {
    return false;
  }
  if (!tag.element.isConnected) {
    return false;
  }
  const currentFingerprint = computeFingerprint(tag.element);
  if (currentFingerprint !== tag.fingerprint) {
    return false;
  }
  return true;
}
function getActiveTagCount() {
  return activeTags.size;
}
function findCandidates(selector, region) {
  let elements = [];
  try {
    elements = Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
  elements = elements.filter((el) => {
    if (isInsideCrossOriginIframe(el)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  elements = dedupeByAncestry(elements);
  if (region && elements.length > MAX_TAGS) {
    elements = narrowByRegion(elements, region);
  }
  const viewportHeight = window.innerHeight;
  elements.sort((a, b) => {
    const aArea = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
    const bArea = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
    const aInView = isNearViewport(a, viewportHeight);
    const bInView = isNearViewport(b, viewportHeight);
    if (aInView !== bInView) return aInView ? -1 : 1;
    const areaRatio = aArea / Math.max(bArea, 1);
    if (areaRatio < 0.5) return -1;
    if (areaRatio > 2) return 1;
    const aInteractive = isInteractiveTag(a);
    const bInteractive = isInteractiveTag(b);
    if (aInteractive !== bInteractive) return aInteractive ? -1 : 1;
    return aArea - bArea;
  });
  return elements.slice(0, MAX_TAGS);
}
function narrowByRegion(elements, region) {
  const regionLower = region.toLowerCase();
  const scored = elements.map((el) => {
    let score = 0;
    const ancestorText = (el.closest("div, section, nav, header, main, aside, form")?.textContent ?? "").toLowerCase();
    if (ancestorText.includes(regionLower)) score += 3;
    const parentText = (el.parentElement?.textContent ?? "").toLowerCase().slice(0, 200);
    if (parentText.includes(regionLower)) score += 2;
    const ariaLabel = (el.getAttribute("aria-label") ?? "").toLowerCase();
    if (ariaLabel.includes(regionLower)) score += 1;
    return { el, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const matches = scored.filter((s) => s.score > 0).map((s) => s.el);
  return matches.length > 0 ? matches.slice(0, MAX_TAGS) : elements.slice(0, MAX_TAGS);
}
function isNearViewport(el, viewportHeight) {
  const rect = el.getBoundingClientRect();
  return rect.top < viewportHeight && rect.bottom > 0;
}
function dedupeByAncestry(elements) {
  const withDepth = elements.map((el) => {
    let depth = 0;
    let node = el;
    while (node && node !== document.body) {
      depth++;
      node = node.parentElement;
    }
    return { el, depth };
  });
  withDepth.sort((a, b) => b.depth - a.depth);
  const result = [];
  for (const { el } of withDepth) {
    const isContained = result.some((selected) => selected.contains(el));
    if (!isContained) {
      result.push(el);
    }
  }
  return result;
}
function isInteractiveTag(el) {
  const tag = el.tagName.toLowerCase();
  return ["a", "button", "input", "select", "textarea"].includes(tag) || el.hasAttribute("role") || el.hasAttribute("onclick");
}
function ensureTagContainer() {
  if (shadowRoot && tagContainer) return;
  const host = document.createElement("chrome-agent-tags");
  host.style.cssText = "position:static;pointer-events:none;";
  document.body.appendChild(host);
  shadowRoot = host.attachShadow({ mode: "closed" });
  const styleReset = document.createElement("style");
  styleReset.textContent = `
    :host { all: initial; }
    * { all: unset; }
  `;
  shadowRoot.appendChild(styleReset);
  tagContainer = document.createElement("div");
  tagContainer.id = "chrome-agent-tag-layer";
  tagContainer.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    z-index: ${computeTagZIndex()};
  `;
  shadowRoot.appendChild(tagContainer);
}
function computeTagZIndex() {
  let maxZ = 0;
  try {
    const allElements = document.querySelectorAll("*");
    for (const el of allElements) {
      const z = parseInt(window.getComputedStyle(el).zIndex, 10);
      if (!isNaN(z) && z > maxZ && z < Z_INDEX_FLOOR) {
        maxZ = z;
      }
    }
  } catch {
  }
  return Math.max(maxZ + 1, Z_INDEX_FLOOR);
}
function createTagElement(id, bounds) {
  const tag = document.createElement("div");
  tag.className = "chrome-agent-tag";
  tag.setAttribute("data-tag-num", String(id));
  tag.setAttribute("aria-hidden", "true");
  tag.style.cssText = `
    position: absolute;
    left: ${bounds.x + window.scrollX}px;
    top: ${bounds.y + window.scrollY}px;
    width: ${Math.max(bounds.width, 24)}px;
    height: ${Math.max(bounds.height, 24)}px;
    pointer-events: none;
    z-index: inherit;
  `;
  const badge = document.createElement("div");
  badge.textContent = String(id);
  badge.style.cssText = `
    position: absolute;
    top: -10px;
    left: -10px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #FF3B30;
    color: white;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 12px;
    font-weight: 700;
    line-height: 20px;
    text-align: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  `;
  tag.appendChild(badge);
  const outline = document.createElement("div");
  outline.style.cssText = `
    position: absolute;
    inset: 0;
    border: 2px solid #FF3B30;
    border-radius: 3px;
    background: rgba(255, 59, 48, 0.08);
  `;
  tag.appendChild(outline);
  return tag;
}
function buildMultiStrategyLocator(el, id) {
  return {
    dataTagId: `[data-tag-id="@${id}"]`,
    cssPath: buildCssPath(el),
    attributeSelector: buildAttributeSelector(el),
    textFragment: (el.textContent ?? "").trim().slice(0, 100)
  };
}
function buildCssPath(el) {
  let stableAncestor = null;
  let current = el.parentElement;
  while (current && current !== document.body) {
    if (current.id || Array.from(current.attributes).some((a) => a.name.startsWith("data-"))) {
      stableAncestor = current;
      break;
    }
    current = current.parentElement;
  }
  const parts = [el.tagName.toLowerCase()];
  let child = el;
  let parent = el.parentElement;
  while (parent && parent !== stableAncestor && parent !== document.body) {
    const siblings = Array.from(parent.children).filter(
      (s) => s.tagName === child.tagName
    );
    const index = siblings.indexOf(child) + 1;
    parts.unshift(`${child.tagName.toLowerCase()}:nth-child(${index})`);
    child = parent;
    parent = parent.parentElement;
  }
  const prefix = stableAncestor ? stableAncestor.id ? `#${CSS.escape(stableAncestor.id)}` : `[${Array.from(stableAncestor.attributes).find((a) => a.name.startsWith("data-")).name}="${CSS.escape(stableAncestor.getAttribute(stableAncestor.attributes[0].name) ?? "")}"]` : "body";
  return `${prefix} > ${parts.join(" > ")}`;
}
function buildAttributeSelector(el) {
  const tag = el.tagName.toLowerCase();
  const attrs = [];
  const type = el.getAttribute("type");
  if (type) attrs.push(`type="${CSS.escape(type)}"`);
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) attrs.push(`aria-label="${CSS.escape(ariaLabel.slice(0, 50))}"`);
  const name = el.getAttribute("name");
  if (name) attrs.push(`name="${CSS.escape(name)}"`);
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) attrs.push(`placeholder="${CSS.escape(placeholder.slice(0, 50))}"`);
  if (attrs.length === 0) {
    return buildCssPath(el);
  }
  return `${tag}[${attrs.join("][")}]`;
}
function findElementByTextFragment(tagName, textFragment) {
  if (!textFragment) return null;
  const elements = document.querySelectorAll(tagName);
  for (const el of elements) {
    if ((el.textContent ?? "").trim().slice(0, 100) === textFragment) {
      return el;
    }
  }
  return null;
}
function computeFingerprint(el) {
  const outer = el.outerHTML.slice(0, 200);
  const rect = el.getBoundingClientRect();
  const rectStr = `${rect.x},${rect.y},${rect.width},${rect.height}`;
  return `${outer}|${rectStr}`;
}
function isInsideCrossOriginIframe(el) {
  try {
    const doc = el.ownerDocument;
    if (doc === document) return false;
    void doc.location.href;
    return false;
  } catch {
    return true;
  }
}
function getElementBounds(el) {
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height
  };
}
function startPositionSync() {
  if (syncRafId !== null) return;
  const sync = () => {
    for (const [, tag] of activeTags) {
      if (!tag.element.isConnected) continue;
      const bounds = getElementBounds(tag.element);
      tag.tagEl.style.left = `${bounds.x}px`;
      tag.tagEl.style.top = `${bounds.y}px`;
      tag.tagEl.style.width = `${Math.max(bounds.width, 24)}px`;
      tag.tagEl.style.height = `${Math.max(bounds.height, 24)}px`;
    }
    syncRafId = requestAnimationFrame(sync);
  };
  syncRafId = requestAnimationFrame(sync);
}
function stopPositionSync() {
  if (syncRafId !== null) {
    cancelAnimationFrame(syncRafId);
    syncRafId = null;
  }
}
function observeTagIntegrity() {
  if (mutationObserver) return;
  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node instanceof Element) {
          for (const [id, tag] of activeTags) {
            if (node.contains(tag.element) || node === tag.element) {
              tag.tagEl.remove();
              activeTags.delete(id);
            }
          }
        }
      }
    }
  });
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}
function stopTagIntegrityObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
}

// src/content/executor.ts
var operationHistory = [];
var MAX_OPERATION_HISTORY = 50;
function recordOperation(action, params, hash) {
  operationHistory.push({
    action,
    params: JSON.stringify(params),
    timestamp: Date.now(),
    hash
  });
  if (operationHistory.length > MAX_OPERATION_HISTORY) {
    operationHistory.shift();
  }
}
function hasBeenExecuted(action, params) {
  const paramsStr = JSON.stringify(params);
  const recent = operationHistory.slice(-10);
  return recent.some((op) => op.action === action && op.params === paramsStr);
}
function computeDomStateHash() {
  const interactiveSelector = 'a, button, input:not([type="hidden"]), select, textarea, [role="button"]';
  const elements = document.querySelectorAll(interactiveSelector);
  const parts = [];
  let count = 0;
  for (const el of elements) {
    if (count >= 50) break;
    const text = (el.textContent ?? "").trim().slice(0, 50);
    const tag = el.tagName;
    const id = el.id || "";
    parts.push(`${tag}#${id}:${text}`);
    count++;
  }
  parts.push(window.location.href);
  return simpleHash(parts.join("|"));
}
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash.toString(36);
}
var MAX_RETRIES = 3;
var RETRY_BASE_DELAY = 1e3;
async function executeClick(params) {
  return executeWithRetry("click", params, async () => {
    const el = mustResolveElement(params.elementId, "click");
    simulateClick(el);
    return `Clicked element #${params.elementId}`;
  });
}
async function executeType(params) {
  return executeWithRetry("type", params, async () => {
    const el = mustResolveElement(params.elementId, "type");
    const input = el;
    if (hasBeenExecuted("type", { elementId: params.elementId, text: params.text.slice(0, 30) })) {
      return `Skipped duplicate type on #${params.elementId}`;
    }
    input.focus();
    input.select();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    if (input instanceof HTMLInputElement && nativeInputValueSetter) {
      nativeInputValueSetter.call(input, params.text);
    } else if (input instanceof HTMLTextAreaElement && nativeTextareaValueSetter) {
      nativeTextareaValueSetter.call(input, params.text);
    } else {
      input.value = params.text;
    }
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return `Typed "${params.text.slice(0, 50)}${params.text.length > 50 ? "\u2026" : ""}" into #${params.elementId}`;
  });
}
async function executeHover(params) {
  return executeWithRetry("hover", params, async () => {
    const el = mustResolveElement(params.elementId, "hover");
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    return `Hovered element #${params.elementId}`;
  });
}
async function executePressKey(params) {
  return executeWithRetry("press_key", params, async () => {
    const keyMap = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
      PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
      Home: { key: "Home", code: "Home", keyCode: 36 },
      End: { key: "End", code: "End", keyCode: 35 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      Delete: { key: "Delete", code: "Delete", keyCode: 46 },
      "Control+A": { key: "a", code: "KeyA", keyCode: 65 },
      "Shift+Tab": { key: "Tab", code: "Tab", keyCode: 9 }
    };
    const keyDef = keyMap[params.key];
    if (!keyDef) {
      throw new Error(`Unknown key: ${params.key}`);
    }
    const target = document.activeElement || document.body;
    const eventInit = {
      key: keyDef.key,
      code: keyDef.code,
      keyCode: keyDef.keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: params.key === "Control+A",
      shiftKey: params.key === "Shift+Tab"
    };
    target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    if (params.key === "Control+A" && target instanceof HTMLInputElement) {
      target.select();
    }
    return `Pressed ${params.key}`;
  });
}
async function executeScrollPage(params) {
  return executeWithRetry("scroll_page", params, async () => {
    const scrollAmount = window.innerHeight * 0.7;
    switch (params.direction) {
      case "up":
        window.scrollBy({ top: -scrollAmount, behavior: "smooth" });
        break;
      case "down":
        window.scrollBy({ top: scrollAmount, behavior: "smooth" });
        break;
      case "top":
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "bottom":
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        break;
    }
    return `Scrolled ${params.direction}`;
  });
}
async function executeWaitFor(params) {
  const startTime = performance.now();
  const timeoutMs = params.timeoutMs ?? 1e4;
  const condition = params.condition;
  while (performance.now() - startTime < timeoutMs) {
    let met = true;
    if (condition.element_visible !== void 0) {
      const el = resolveElementById(condition.element_visible);
      if (!el || !isElementStillValid(condition.element_visible)) {
        met = false;
      }
    }
    if (condition.element_hidden !== void 0) {
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
      const pending = performance.getEntriesByType("resource").filter(
        (e) => e.duration === 0
      );
      if (pending.length > 0) {
        met = false;
      }
    }
    if (condition.dom_stable) {
      met = met && true;
    }
    if (met) {
      return {
        success: true,
        actionTaken: `Condition met after ${Math.round(performance.now() - startTime)}ms`,
        preOperationHash: "",
        postOperationHash: computeDomStateHash()
      };
    }
    await sleep(100);
  }
  return {
    success: false,
    actionTaken: `Timeout waiting for condition`,
    preOperationHash: "",
    postOperationHash: computeDomStateHash(),
    error: `Condition not met within ${timeoutMs}ms`
  };
}
async function executeHandleDialog(params) {
  return {
    success: true,
    actionTaken: `Dialog ${params.action}ed`,
    preOperationHash: "",
    postOperationHash: computeDomStateHash(),
    dialogHandled: true
  };
}
async function executeWithRetry(action, params, fn) {
  const preHash = computeDomStateHash();
  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const description = await fn();
      await sleep(200);
      const postHash = computeDomStateHash();
      if (preHash === postHash && action !== "scroll_page") {
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
        postOperationHash: postHash
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
    error: lastError?.message ?? "Max retries exhausted"
  };
}
function mustResolveElement(elementId, action) {
  const el = resolveElementById(elementId);
  if (!el) {
    throw new Error(`Element #${elementId} not found for ${action}. It may have been removed from the DOM.`);
  }
  if (!isElementStillValid(elementId)) {
    throw new Error(`Element #${elementId} is no longer valid for ${action}. Fingerprint mismatch or TTL expired.`);
  }
  return el;
}
function simulateClick(el) {
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: 1
  };
  el.dispatchEvent(new MouseEvent("mousedown", eventInit));
  el.dispatchEvent(new MouseEvent("mouseup", eventInit));
  el.dispatchEvent(new MouseEvent("click", eventInit));
  if (el instanceof HTMLElement) {
    el.click();
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function clearOperationHistory() {
  operationHistory.length = 0;
}

// src/content/dispatcher.ts
var currentState = "idle";
var semanticObserver = null;
var extractResultCache = null;
var extractResultStale = true;
var semanticIdToSelector = /* @__PURE__ */ new Map();
function transition(newState) {
  const validTransitions = {
    idle: ["extracting", "executing"],
    extracting: ["idle", "rendering"],
    rendering: ["idle", "executing"],
    executing: ["idle", "extracting", "rendering"]
  };
  if (!validTransitions[currentState].includes(newState)) {
    console.warn(`[dispatcher] Invalid state transition: ${currentState} \u2192 ${newState}`);
    return;
  }
  console.log(`[dispatcher] ${currentState} \u2192 ${newState}`);
  currentState = newState;
}
function startObserving() {
  if (semanticObserver) return;
  semanticObserver = createSemanticObserver({
    debounceMs: 500,
    onStructureChanged: (_structure) => {
      extractResultStale = true;
    }
  });
  semanticObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "aria-expanded", "hidden", "class"]
  });
}
function stopObserving() {
  if (semanticObserver) {
    semanticObserver.disconnect();
    semanticObserver = null;
  }
  extractResultCache = null;
  extractResultStale = true;
}
async function dispatch(action, params) {
  switch (action) {
    case "ping":
      return { success: true, data: { pong: true } };
    case "get_page_semantic_structure":
      return handleGetSemanticStructure();
    case "extract_text":
      return handleExtractText(params);
    case "tag_elements":
      return handleTagElements(params);
    case "call_vision_model":
      return handleCallVisionModel(params);
    case "execute_click":
      return handleExecute("click", params);
    case "execute_type":
      return handleExecute("type", params);
    case "hover":
      return handleExecute("hover", params);
    case "press_key":
      return handleExecute("press_key", params);
    case "scroll_page":
      return handleExecute("scroll_page", params);
    case "wait_for":
      return handleWaitFor(params);
    case "handle_dialog":
      return handleExecute("handle_dialog", params);
    case "execute_javascript":
      return handleExecuteJavascript(params);
    case "cleanup":
      return handleCleanup();
    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}
async function handleGetSemanticStructure() {
  transition("extracting");
  try {
    const structure = await extractPageSemantics();
    extractResultCache = structure;
    extractResultStale = false;
    semanticIdToSelector = structure.__selectorMap ?? /* @__PURE__ */ new Map();
    transition("idle");
    return { success: true, data: structure };
  } catch (err) {
    transition("idle");
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleExtractText(params) {
  transition("executing");
  try {
    const elementId = params.element_id;
    const selector = semanticIdToSelector.get(elementId);
    let el = null;
    if (selector) {
      try {
        el = document.querySelector(selector);
      } catch {
      }
    }
    if (!el) {
      el = resolveElementById(elementId);
    }
    if (!el) {
      transition("idle");
      return { success: false, error: `Element #${elementId} not found on page (may have been removed or re-rendered). Try get_page_semantic_structure again.` };
    }
    const text = (el.textContent ?? "").trim().slice(0, 500);
    extractResultStale = true;
    transition("idle");
    const response = {
      requestId: "",
      success: true,
      text
    };
    return { success: true, data: response };
  } catch (err) {
    transition("idle");
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleTagElements(params) {
  if (currentState !== "idle" && currentState !== "extracting") {
    return { success: false, error: `Cannot tag elements in ${currentState} state` };
  }
  transition("rendering");
  try {
    const selector = params.selector;
    const region = params.region;
    removeAllTags();
    const tagged = tagElements(selector, region);
    const boundsUnion = getTagsBoundingUnion(20);
    extractResultStale = true;
    transition("idle");
    const response = {
      requestId: "",
      success: true,
      tagged,
      boundsUnion: boundsUnion ?? { x: 0, y: 0, width: 0, height: 0 }
    };
    return { success: true, data: response };
  } catch (err) {
    transition("idle");
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleCallVisionModel(params) {
  try {
    const question = params.question;
    const boundsUnion = getTagsBoundingUnion(20);
    if (getActiveTagCount() === 0) {
      return { success: false, error: "No tagged elements. Call tag_elements first." };
    }
    return {
      success: true,
      data: {
        question,
        boundsUnion,
        tagCount: getActiveTagCount()
      }
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleExecute(type, params) {
  transition("executing");
  extractResultStale = true;
  try {
    let result;
    switch (type) {
      case "click":
        result = await executeClick({ elementId: params.element_id });
        break;
      case "type":
        result = await executeType({
          elementId: params.element_id,
          text: params.text
        });
        break;
      case "hover":
        result = await executeHover({ elementId: params.element_id });
        break;
      case "press_key":
        result = await executePressKey({ key: params.key });
        break;
      case "scroll_page":
        result = await executeScrollPage({
          direction: params.direction
        });
        break;
      case "handle_dialog":
        result = await executeHandleDialog({
          action: params.dialog_action,
          promptText: params.prompt_text
        });
        break;
      default:
        transition("idle");
        return { success: false, error: `Unknown execute type: ${type}` };
    }
    transition("idle");
    if (result.success) {
      const response = {
        requestId: "",
        success: true,
        actionTaken: result.actionTaken,
        preOperationHash: result.preOperationHash,
        postOperationHash: result.postOperationHash
      };
      return { success: true, data: response };
    } else {
      return { success: false, error: result.error, data: result };
    }
  } catch (err) {
    transition("idle");
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleWaitFor(params) {
  transition("executing");
  try {
    const result = await executeWaitFor({
      condition: params.condition ?? {},
      timeoutMs: params.timeout_ms
    });
    transition("idle");
    const response = {
      requestId: "",
      success: result.success,
      conditionMet: result.success,
      elapsedMs: 0
    };
    return { success: result.success, data: response, error: result.error };
  } catch (err) {
    transition("idle");
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleExecuteJavascript(params) {
  transition("executing");
  try {
    const code = params.code;
    const { validateCode: validateCode2 } = await Promise.resolve().then(() => (init_sandbox(), sandbox_exports));
    const validation = validateCode2(code);
    if (!validation.valid) {
      transition("idle");
      return { success: false, error: `Sandbox rejection: ${validation.reason}` };
    }
    const result = new Function(`"use strict"; return (${code})`)();
    transition("idle");
    return { success: true, data: { result } };
  } catch (err) {
    transition("idle");
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function handleCleanup() {
  transition("idle");
  removeAllTags();
  stopObserving();
  clearOperationHistory();
  extractResultCache = null;
  extractResultStale = true;
  return { success: true, data: { cleaned: true } };
}

// src/content/content.ts
var originalAttachShadow = Element.prototype.attachShadow;
var patchWarned = false;
Element.prototype.attachShadow = function(init) {
  if (init.mode === "closed") {
    if (!patchWarned) {
      console.log("[chrome-agent] Shadow DOM monkey-patch: forcing closed \u2192 open mode");
      patchWarned = true;
    }
    return originalAttachShadow.call(this, { ...init, mode: "open" });
  }
  return originalAttachShadow.call(this, init);
};
if (typeof HTMLElement !== "undefined" && HTMLElement.prototype.attachShadow) {
  HTMLElement.prototype.attachShadow = Element.prototype.attachShadow;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    console.error("[chrome-agent] Message from untrusted sender:", sender.id);
    sendResponse({ success: false, error: "Untrusted sender" });
    return false;
  }
  if (!message || typeof message !== "object" || !message.action) {
    sendResponse({ success: false, error: "Invalid message format" });
    return false;
  }
  const { action, ...params } = message;
  handleMessage(action, params).then((result) => {
    try {
      sendResponse(result);
    } catch {
    }
  });
  return true;
});
async function handleMessage(action, params) {
  try {
    const result = await dispatch(action, params);
    return {
      success: result.success,
      data: result.data,
      error: result.error
    };
  } catch (err) {
    console.error(`[chrome-agent] Error handling ${action}:`, err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
if (document.body) {
  startObserving();
} else {
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      startObserving();
    }
  });
  observer.observe(document.documentElement, { childList: true });
}
window.addEventListener("beforeunload", () => {
  stopObserving();
});
window.addEventListener("pagehide", () => {
  stopObserving();
});
window.addEventListener("pageshow", () => {
  if (document.body) {
    startObserving();
  }
});
console.log("[chrome-agent] Content script loaded. Shadow DOM patch active.");
