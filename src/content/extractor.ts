// ============================================================================
// Semantic Extraction Engine (extractor.ts — MAIN world, read-only)
//
// Uses TreeWalker for viewport-limited DOM traversal. Extracts a structured
// text semantic skeleton that DeepSeek can "skim-read" in a few hundred tokens.
//
// Key constraints:
//   - THIS MODULE RUNS IN THE MAIN WORLD (access to real DOM)
//   - Read-only: NEVER mutates DOM, NEVER exports live Element references
//   - All text passes through the content filter pipeline before output
// ============================================================================

import type {
  PageSemanticStructure,
  FormArea,
  FormField,
  InteractiveElement,
  StructuralArea,
} from '../shared/messages';
import {
  filterInputElement,
  filterTextContent,
  filterHref,
  filterAttributeName,
  sanitizeUrl,
  isInViewport,
  isElementVisible,
  enforceTokenBudget,
} from './filter';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Max interactive elements to extract (viewport mode). */
const MAX_INTERACTIVE_ELEMENTS = 200;

/** Max TreeWalker depth to prevent excessive recursion. */
const MAX_TREE_DEPTH = 15;

/** Yield event loop every N elements to avoid blocking the main thread. */
const YIELD_EVERY_N = 50;

/** Total extraction timeout in ms — abort and return partial results. */
const EXTRACTION_TIMEOUT_MS = 1000;

/** Threshold for switching to viewport-only mode. */
const LARGE_PAGE_THRESHOLD = 5000;

/** Interactive element selectors. */
const INTERACTIVE_SELECTORS = [
  'a[href]',
  'button',
  'input:not([type="hidden"]):not([type="password"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  'details > summary',
];

/** Navigation selectors — common patterns for site navigation. */
const NAV_SELECTORS = [
  'nav',
  '[role="navigation"]',
  'header',
  '.nav',
  '.navbar',
  '.navigation',
  '.menu',
  '#nav',
  '#navbar',
  '#navigation',
  '#menu',
];

/** Form region selectors. */
const FORM_SELECTORS = [
  'form',
  '[role="form"]',
  '[role="search"]',
  '.search',
  '#search',
];

/** Structural area selectors. */
const STRUCTURAL_SELECTORS = [
  '[role="list"]',
  '[role="listbox"]',
  '[role="grid"]',
  '[role="article"]',
  'ul',
  'ol',
  'table',
  '.card',
  '.result',
  '.item',
  '[data-result]',
  '.search-result',
];

// ─── Extraction State ───────────────────────────────────────────────────────

interface ExtractionState {
  interactiveElements: InteractiveElement[];
  interactiveCount: number;
  forms: FormArea[];
  navItems: string[];
  structuralAreas: StructuralArea[];
  seenText: Set<string>; // dedup by text content
  elementIdCounter: number;
  startTime: number;
  timedOut: boolean;
  mode: 'viewport' | 'full_page';
  /** Maps semantic element ID → CSS selector (for extract_text lookup). */
  selectorMap: Map<number, string>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Yield control back to the event loop to avoid blocking. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Simple hash function for deduplication. */
function textFingerprint(text: string): string {
  // Use first 50 chars as a quick fingerprint for dedup
  return text.slice(0, 50).toLowerCase().trim();
}

/** Check if we've exceeded the timeout. */
function isTimedOut(state: ExtractionState): boolean {
  if (state.timedOut) return true;
  if (performance.now() - state.startTime > EXTRACTION_TIMEOUT_MS) {
    state.timedOut = true;
    return true;
  }
  return false;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Extract the semantic structure of the current page.
 *
 * This is the SOLE entry point called by the content script dispatcher.
 * All filtering happens inline — the output is ready to send to DeepSeek.
 *
 * @returns Structured semantic skeleton of the page.
 */
export async function extractPageSemantics(): Promise<PageSemanticStructure> {
  const startTime = performance.now();

  // Determine extraction mode
  const totalElements = document.querySelectorAll('*').length;
  const mode: 'viewport' | 'full_page' = totalElements > LARGE_PAGE_THRESHOLD ? 'viewport' : 'full_page';

  const state: ExtractionState = {
    interactiveElements: [],
    interactiveCount: 0,
    forms: [],
    navItems: [],
    structuralAreas: [],
    seenText: new Set(),
    elementIdCounter: 0,
    startTime,
    timedOut: false,
    mode,
    selectorMap: new Map(),
  };

  // Extract in parallel-ish (these are sequential but with yields)
  extractTitle(state);
  extractNavigation(state);

  // TreeWalker traversal for interactive elements (the heavy part)
  await extractInteractiveElements(state);

  // Extract forms and structural areas after interactive elements
  // (forms are more important for task completion)
  extractForms(state);
  extractStructuralAreas(state);

  const durationMs = performance.now() - startTime;
  const truncated = state.timedOut || state.interactiveCount >= MAX_INTERACTIVE_ELEMENTS;

  const structure = enforceTokenBudget({
    title: document.title,
    navItems: state.navItems,
    formText: state.forms.map((f) => f.region + ': ' + f.fields.map((fd) => fd.label).join(', ')).join(' | '),
    interactiveText: state.interactiveElements.map((el) => el.text + (el.placeholder ? ` (${el.placeholder})` : '')).join(' | '),
    structuralText: state.structuralAreas.map((a) => a.sampleText).join(' | '),
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
        required: fd.required,
      })),
    })),
    interactiveElements: state.interactiveElements.slice(0, MAX_INTERACTIVE_ELEMENTS),
    structuralAreas: state.structuralAreas,
    // Attach selector map for extract_text lookup (not part of the public API)
    __selectorMap: state.selectorMap as any,
    extractionMetadata: {
      mode,
      totalElements,
      interactiveCount: state.interactiveElements.length,
      durationMs: Math.round(durationMs),
      truncated,
    },
  };
  return result as PageSemanticStructure;
}

// ─── Title Extraction ──────────────────────────────────────────────────────

function extractTitle(state: ExtractionState): void {
  // Title is extracted from document.title (filtered)
  // No DOM traversal needed
  void state;
}

// ─── Navigation Extraction ─────────────────────────────────────────────────

function extractNavigation(state: ExtractionState): void {
  const navContainers: Element[] = [];

  for (const selector of NAV_SELECTORS) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (isElementVisible(el)) {
          navContainers.push(el);
        }
      }
      if (navContainers.length > 0) break; // Found a nav — stop searching
    } catch {
      // Invalid selector — skip
    }
  }

  if (navContainers.length === 0) return;

  // Extract links from the first visible nav
  const nav = navContainers[0];
  const links = nav.querySelectorAll('a[href]');

  for (const link of links) {
    if (state.navItems.length >= 20) break; // Max 20 nav items
    if (!isElementVisible(link)) continue;

    const text = filterTextContent(link.textContent ?? '', 60);
    if (text && !state.seenText.has(textFingerprint(text))) {
      state.seenText.add(textFingerprint(text));
      state.navItems.push(text);
    }
  }
}

// ─── Interactive Element Extraction (TreeWalker) ───────────────────────────

async function extractInteractiveElements(state: ExtractionState): Promise<void> {
  const viewportHeight = window.innerHeight;
  let processedSinceYield = 0;

  // Strategy: use TreeWalker for depth-limited traversal, filtering by visibility
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node: Node): number {
        if (isTimedOut(state)) return NodeFilter.FILTER_REJECT;
        if (state.interactiveCount >= MAX_INTERACTIVE_ELEMENTS) return NodeFilter.FILTER_REJECT;

        const el = node as Element;
        const tagDepth = computeDepth(el);

        if (tagDepth > MAX_TREE_DEPTH) {
          return NodeFilter.FILTER_REJECT; // Skip children of deep elements
        }

        // Always traverse children of potential containers
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let currentNode = walker.nextNode();
  const interactiveSelectorStr = INTERACTIVE_SELECTORS.join(',');

  while (currentNode && state.interactiveCount < MAX_INTERACTIVE_ELEMENTS && !isTimedOut(state)) {
    const el = currentNode as Element;

    // Check if this specific element is interactive
    if (matchesInteractive(el, interactiveSelectorStr)) {
      // Viewport filtering
      if (state.mode === 'viewport' && !isInViewport(el, viewportHeight)) {
        currentNode = walker.nextNode();
        continue;
      }

      // Visibility check
      if (!isElementVisible(el)) {
        currentNode = walker.nextNode();
        continue;
      }

      // Extract element info
      const interactiveEl = extractInteractiveElement(el, state);
      if (interactiveEl) {
        state.interactiveElements.push(interactiveEl);
        state.interactiveCount++;
        processedSinceYield++;
      }
    }

    // Yield event loop every N elements to prevent blocking
    if (processedSinceYield >= YIELD_EVERY_N) {
      processedSinceYield = 0;
      await yieldToEventLoop();
    }

    currentNode = walker.nextNode();
  }
}

// ─── Form Extraction ───────────────────────────────────────────────────────

function extractForms(state: ExtractionState): void {
  for (const selector of FORM_SELECTORS) {
    try {
      const containers = document.querySelectorAll(selector);
      for (const container of containers) {
        if (!isElementVisible(container)) continue;
        if (isTimedOut(state)) return;

        const form: FormArea = {
          region: getFormRegionName(container),
          fields: [],
        };

        // Extract form fields
        const inputs = container.querySelectorAll('input, select, textarea, [role="combobox"], [role="listbox"]');
        for (const input of inputs) {
          if (form.fields.length >= 10) break; // Max 10 fields per form

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
      // Invalid selector — skip
    }
  }

  // If no forms found via form containers, look for standalone inputs with labels
  if (state.forms.length === 0) {
    const standaloneInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="password"])[id], textarea[id], select[id]');
    const standaloneFields: FormField[] = [];

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
        region: 'page',
        fields: standaloneFields,
      });
    }
  }
}

// ─── Structural Area Extraction ────────────────────────────────────────────

function extractStructuralAreas(state: ExtractionState): void {
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
      // Skip
    }
  }
}

// ─── Element-level Extraction Helpers ──────────────────────────────────────

function matchesInteractive(el: Element, selectorStr: string): boolean {
  try {
    return el.matches(selectorStr);
  } catch {
    return false;
  }
}

function computeDepth(el: Element): number {
  let depth = 0;
  let current: Node | null = el;
  while (current && current !== document.documentElement) {
    depth++;
    current = current.parentElement;
  }
  return depth;
}

function extractInteractiveElement(el: Element, state: ExtractionState): InteractiveElement | null {
  const tagName = el.tagName.toLowerCase();
  const text = filterTextContent(el.textContent ?? '', 200);

  // Dedup by text fingerprint (skip duplicate text elements)
  const fp = textFingerprint(text);
  if (fp && state.seenText.has(fp)) return null;
  if (fp) state.seenText.add(fp);

  const id = ++state.elementIdCounter;

  // Build a CSS selector for extract_text lookup
  const selector = buildUniqueSelector(el);
  state.selectorMap.set(id, selector);

  const element: InteractiveElement = {
    id,
    tagName,
    text,
    type: (el as HTMLInputElement).type || undefined,
    role: el.getAttribute('role') || undefined,
    ariaLabel: el.getAttribute('aria-label')?.slice(0, 200) || undefined,
    href: filterHref(el.getAttribute('href')),
    placeholder: (el as HTMLInputElement).placeholder?.slice(0, 200) || undefined,
    visible: isElementVisible(el),
  };

  return element;
}

/** Build a reasonably unique CSS selector for an element. */
function buildUniqueSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id;
  if (id) return `#${CSS.escape(id)}`;

  // Try a combination: tag + key attributes
  const type = el.getAttribute('type');
  const name = el.getAttribute('name');
  const role = el.getAttribute('role');
  const ariaLabel = el.getAttribute('aria-label');
  const placeholder = (el as HTMLInputElement).placeholder;

  if (type && name) return `${tag}[type="${CSS.escape(type)}"][name="${CSS.escape(name)}"]`;
  if (type && placeholder) return `${tag}[type="${CSS.escape(type)}"][placeholder="${CSS.escape(placeholder)}"]`;
  if (name) return `${tag}[name="${CSS.escape(name)}"]`;
  if (role) return `${tag}[role="${CSS.escape(role)}"]`;
  if (ariaLabel) return `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
  if (type) return `${tag}[type="${CSS.escape(type)}"]`;

  // Fallback: nth-child path from body
  const parts: string[] = [tag];
  let child: Element | null = el;
  let parent: Element | null = el.parentElement;
  while (parent && parent !== document.body && parts.length < 5) {
    const siblings = Array.from(parent.children);
    const idx = siblings.indexOf(child!) + 1;
    parts.unshift(`> :nth-child(${idx})`);
    child = parent;
    parent = parent.parentElement;
  }

  return 'body ' + parts.join(' ');
}

function extractFormField(el: Element): FormField | null {
  const tagName = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type || tagName;

  // Apply content filter pipeline
  const filterResult = filterInputElement(
    tagName,
    type,
    el.getAttribute('name'),
    (el as HTMLInputElement).placeholder,
    el.getAttribute('aria-label'),
  );

  if (!filterResult.include) return null;

  // Find associated label
  let label = '';
  const id = el.getAttribute('id');
  if (id) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (labelEl) {
      label = filterTextContent(labelEl.textContent ?? '', 100);
    }
  }
  // Fallback: check if input is wrapped in a label
  if (!label) {
    const parentLabel = el.closest('label');
    if (parentLabel) {
      label = filterTextContent(parentLabel.textContent ?? '', 100);
    }
  }
  // Fallback: use placeholder or aria-label
  if (!label) {
    label = filterResult.placeholder ?? filterResult.ariaLabel ?? '';
  }

  return {
    label: filterTextContent(label, 100),
    placeholder: filterResult.placeholder,
    name: filterResult.name ? filterAttributeName(filterResult.name) : undefined,
    type: filterResult.type ?? type,
    required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
  };
}

function getFormRegionName(container: Element): string {
  // Try to find a heading or legend near the form
  const heading = container.querySelector('h1, h2, h3, h4, legend');
  if (heading && heading.textContent) {
    return filterTextContent(heading.textContent, 50);
  }

  // Check aria-label or data attributes
  const ariaLabel = container.getAttribute('aria-label');
  if (ariaLabel) return filterTextContent(ariaLabel, 50);

  const role = container.getAttribute('role');
  if (role === 'search') return 'search';

  // Fall back to class/id based naming
  const className = container.className?.toString() ?? '';
  const id = container.id ?? '';

  if (className.includes('search') || id.includes('search')) return 'search';
  if (className.includes('login') || id.includes('login')) return 'login';
  if (className.includes('register') || id.includes('register')) return 'register';
  if (className.includes('contact') || id.includes('contact')) return 'contact';

  return 'form';
}

function classifyStructuralArea(container: Element): StructuralArea | null {
  const role = container.getAttribute('role');
  const tagName = container.tagName.toLowerCase();

  let type: StructuralArea['type'] = 'other';
  if (role === 'list' || role === 'listbox' || tagName === 'ul' || tagName === 'ol') {
    type = 'list';
  } else if (role === 'article' || container.matches('.card, .result-card, [class*="card"]')) {
    type = 'card';
  } else if (container.matches('.search-result, [class*="search-result"], [class*="searchResult"]')) {
    type = 'search_result';
  } else if (role === 'navigation' || tagName === 'nav') {
    type = 'navigation';
  }

  // Count direct children that look like items
  const items = container.querySelectorAll(':scope > li, :scope > [role="listitem"], :scope > [role="option"], :scope > .item, :scope > .card, :scope > .result, :scope > tr');
  const count = items.length || container.children.length;

  // Get sample text
  const sampleText = filterTextContent(container.textContent ?? '', 200);

  return {
    type,
    count: count > 1 ? count : undefined,
    sampleText,
  };
}

// ─── MutationObserver-based Incremental Update ─────────────────────────────
// For SPA / dynamic content, the dispatcher can set up a MutationObserver
// that triggers lightweight re-extraction when significant DOM changes occur.

export interface MutationObserverConfig {
  /** Callback invoked with the updated semantic structure. */
  onStructureChanged: (structure: PageSemanticStructure) => void;
  /** Debounce interval in ms. */
  debounceMs: number;
}

/**
 * Create a MutationObserver that triggers re-extraction on significant DOM mutations.
 * For SPA routes, infinite scroll, and dynamic content loading.
 *
 * Debounced: multiple rapid mutations coalesce into a single re-extraction.
 */
export function createSemanticObserver(config: MutationObserverConfig): MutationObserver {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const observer = new MutationObserver((mutations) => {
    // Filter mutations to only significant ones (ignore attribute-only changes
    // on non-interactive elements, style changes, etc.)
    const hasStructuralChange = mutations.some((m) => {
      if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
        // Only consider it significant if the added/removed nodes are elements
        // (ignore text node-only changes)
        return Array.from(m.addedNodes).some((n) => n.nodeType === Node.ELEMENT_NODE) ||
               Array.from(m.removedNodes).some((n) => n.nodeType === Node.ELEMENT_NODE);
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
