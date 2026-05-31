// ============================================================================
// On-Demand Tag Rendering Engine (injector.ts — ISOLATED world)
//
// Upgraded Set-of-Mark: tags only the target region's ~3-10 elements
// instead of flooding the entire page with numbers.
//
// Key constraints:
//   - THIS MODULE RUNS IN ISOLATED WORLD (cannot access page JS variables)
//   - Shadow DOM closed mode: CSS isolation from page styles
//   - Tags appended to <body> end: avoids stacking context traps
//   - pointer-events: none + aria-hidden: no interaction interference
//   - Never imports extractor internals
// ============================================================================

import type { TaggedElement, BoundingBox, MultiStrategyLocator } from '../shared/messages';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Max elements to tag in a single call. */
const MAX_TAGS = 10;

/** Default tag TTL in ms (plan: 30 seconds). */
const DEFAULT_TAG_TTL_MS = 30_000;

/** z-index floor to ensure tags are always on top. */
const Z_INDEX_FLOOR = 2147483647; // max 32-bit signed int

// ─── Tag State ─────────────────────────────────────────────────────────────

interface ActiveTag {
  id: number;
  element: Element;
  tagEl: HTMLElement;
  locators: MultiStrategyLocator;
  ttlMs: number;
  createdAt: number;
  fingerprint: string;
}

const activeTags = new Map<number, ActiveTag>();
let shadowRoot: ShadowRoot | null = null;
let tagContainer: HTMLElement | null = null;
let syncRafId: number | null = null;
let mutationObserver: MutationObserver | null = null;

// ─── Tag Rendering ─────────────────────────────────────────────────────────

/**
 * Tag elements matching the CSS selector within an optional region description.
 *
 * @param selector - CSS selector for target elements
 * @param region - Optional human-readable region to narrow down (e.g., "top nav")
 * @param ttlMs - Tag validity duration (default 30s)
 * @returns List of tagged elements with their locators
 */
export function tagElements(
  selector: string,
  region?: string,
  ttlMs = DEFAULT_TAG_TTL_MS,
): TaggedElement[] {
  // Clean up existing tags first
  removeAllTags();

  // Find candidate elements
  const candidates = findCandidates(selector, region);

  // Limit to MAX_TAGS
  const toTag = candidates.slice(0, MAX_TAGS);

  // Ensure Shadow DOM container exists
  ensureTagContainer();

  const tagged: TaggedElement[] = [];
  let idCounter = 1;

  for (const el of toTag) {
    const id = idCounter++;
    const locators = buildMultiStrategyLocator(el, id);
    const boundingRect = getElementBounds(el);

    // Create tag element
    const tagEl = createTagElement(id, boundingRect);

    // Store tag data attribute on the element itself
    el.setAttribute('data-tag-id', `@${id}`);

    // Add to Shadow DOM container
    tagContainer!.appendChild(tagEl);

    const tag: ActiveTag = {
      id,
      element: el,
      tagEl,
      locators,
      ttlMs,
      createdAt: performance.now(),
      fingerprint: computeFingerprint(el),
    };

    activeTags.set(id, tag);

    tagged.push({
      id,
      tagName: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim().slice(0, 100),
      boundingRect,
      locators,
    });
  }

  // Start position sync
  startPositionSync();

  // Observe tag element removal
  observeTagIntegrity();

  return tagged;
}

/**
 * Remove all active tags and clean up listeners.
 */
export function removeAllTags(): void {
  stopPositionSync();
  stopTagIntegrityObserver();

  for (const [, tag] of activeTags) {
    tag.element.removeAttribute('data-tag-id');
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

/**
 * Get the union bounding box of all active tags (for screenshot cropping).
 */
export function getTagsBoundingUnion(margin = 20): BoundingBox | null {
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
    height: maxY - minY + margin * 2,
  };
}

/**
 * Resolve an element by its tag ID using multi-strategy locators.
 * Returns the element reference or null if not found.
 */
export function resolveElementById(id: number): Element | null {
  const tag = activeTags.get(id);
  if (!tag) return null;

  // Strategy 0: Check if the original element reference is still valid
  if (tag.element.isConnected && tag.element.hasAttribute('data-tag-id')) {
    const attr = tag.element.getAttribute('data-tag-id');
    if (attr === `@${id}`) return tag.element;
  }

  // Strategy 1: data-tag-id attribute search (most reliable)
  const byDataTag = document.querySelector(`[data-tag-id="@${id}"]`);
  if (byDataTag) return byDataTag;

  // Strategy 2: CSS path from stable ancestor
  try {
    const byCssPath = document.querySelector(tag.locators.cssPath);
    if (byCssPath) return byCssPath;
  } catch {
    // Invalid CSS path — try next strategy
  }

  // Strategy 3: Attribute selector
  try {
    const byAttr = document.querySelector(tag.locators.attributeSelector);
    if (byAttr) return byAttr;
  } catch {
    // Skip
  }

  // Strategy 4: Text fragment (weakest — last resort)
  const byText = findElementByTextFragment(tag.element.tagName.toLowerCase(), tag.locators.textFragment);
  if (byText) return byText;

  return null;
}

/**
 * Check if a tagged element is still alive and hasn't changed.
 */
export function isElementStillValid(id: number): boolean {
  const tag = activeTags.get(id);
  if (!tag) return false;

  // TTL check
  if (performance.now() - tag.createdAt > tag.ttlMs) {
    return false;
  }

  // Connection check
  if (!tag.element.isConnected) {
    return false;
  }

  // Fingerprint check
  const currentFingerprint = computeFingerprint(tag.element);
  if (currentFingerprint !== tag.fingerprint) {
    return false;
  }

  return true;
}

/**
 * Get active tag count.
 */
export function getActiveTagCount(): number {
  return activeTags.size;
}

// ─── Internal: Candidate Finding ───────────────────────────────────────────

function findCandidates(selector: string, region?: string): Element[] {
  let elements: Element[] = [];

  try {
    elements = Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }

  // Filter to visible, accessible elements
  elements = elements.filter((el) => {
    // Skip elements inside cross-origin iframes (we can't place tags there)
    if (isInsideCrossOriginIframe(el)) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // Remove elements that are ancestors of other matched elements
  // (keep the most specific / leaf-level elements)
  elements = dedupeByAncestry(elements);

  // If region is specified, try to narrow down
  if (region && elements.length > MAX_TAGS) {
    elements = narrowByRegion(elements, region);
  }

  // Score and sort: prefer small + interactive + in-viewport
  const viewportHeight = window.innerHeight;
  elements.sort((a, b) => {
    const aArea = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
    const bArea = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
    const aInView = isNearViewport(a, viewportHeight);
    const bInView = isNearViewport(b, viewportHeight);

    // Prefer in-viewport elements
    if (aInView !== bInView) return aInView ? -1 : 1;

    // Prefer smaller elements (more specific)
    const areaRatio = aArea / Math.max(bArea, 1);
    if (areaRatio < 0.5) return -1;  // a is much smaller
    if (areaRatio > 2) return 1;     // b is much smaller

    // Prefer interactive elements over generic ones
    const aInteractive = isInteractiveTag(a);
    const bInteractive = isInteractiveTag(b);
    if (aInteractive !== bInteractive) return aInteractive ? -1 : 1;

    return aArea - bArea; // smaller first
  });

  return elements.slice(0, MAX_TAGS);
}

function narrowByRegion(elements: Element[], region: string): Element[] {
  const regionLower = region.toLowerCase();

  // Try to find elements near text matching the region description
  const scored = elements.map((el) => {
    let score = 0;

    // Check if element or its ancestors contain the region text
    const ancestorText = (el.closest('div, section, nav, header, main, aside, form')?.textContent ?? '').toLowerCase();
    if (ancestorText.includes(regionLower)) score += 3;

    // Check nearby text
    const parentText = (el.parentElement?.textContent ?? '').toLowerCase().slice(0, 200);
    if (parentText.includes(regionLower)) score += 2;

    // Check element's own attributes
    const ariaLabel = (el.getAttribute('aria-label') ?? '').toLowerCase();
    if (ariaLabel.includes(regionLower)) score += 1;

    return { el, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Return elements with score > 0, or original list if none match
  const matches = scored.filter((s) => s.score > 0).map((s) => s.el);
  return matches.length > 0 ? matches.slice(0, MAX_TAGS) : elements.slice(0, MAX_TAGS);
}

function isNearViewport(el: Element, viewportHeight: number): boolean {
  const rect = el.getBoundingClientRect();
  return rect.top < viewportHeight && rect.bottom > 0;
}

/**
 * Remove elements that are ancestors of other matched elements.
 * When both a container AND its children match the selector,
 * keep only the children (most specific / leaf elements).
 */
function dedupeByAncestry(elements: Element[]): Element[] {
  // Sort by DOM depth descending (deepest first)
  const withDepth = elements.map(el => {
    let depth = 0;
    let node: Node | null = el;
    while (node && node !== document.body) { depth++; node = node.parentElement; }
    return { el, depth };
  });
  withDepth.sort((a, b) => b.depth - a.depth);

  const result: Element[] = [];
  for (const { el } of withDepth) {
    // Check if el is contained by any already-selected element
    const isContained = result.some(selected => selected.contains(el));
    if (!isContained) {
      result.push(el);
    }
  }
  return result;
}

function isInteractiveTag(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ||
    el.hasAttribute('role') ||
    el.hasAttribute('onclick');
}

// ─── Internal: Shadow DOM Container ────────────────────────────────────────

function ensureTagContainer(): void {
  if (shadowRoot && tagContainer) return;

  // Create a container element that will host the Shadow DOM
  const host = document.createElement('chrome-agent-tags');
  host.style.cssText = 'position:static;pointer-events:none;';

  // Append as last child of body — avoids stacking context issues
  document.body.appendChild(host);

  shadowRoot = host.attachShadow({ mode: 'closed' });

  // Reset styles inside Shadow DOM to ensure isolation
  const styleReset = document.createElement('style');
  styleReset.textContent = `
    :host { all: initial; }
    * { all: unset; }
  `;
  shadowRoot.appendChild(styleReset);

  // Create tag container
  tagContainer = document.createElement('div');
  tagContainer.id = 'chrome-agent-tag-layer';
  tagContainer.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    z-index: ${computeTagZIndex()};
  `;
  shadowRoot.appendChild(tagContainer);
}

function computeTagZIndex(): number {
  // Scan page for highest z-index
  let maxZ = 0;
  try {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const z = parseInt(window.getComputedStyle(el).zIndex, 10);
      if (!isNaN(z) && z > maxZ && z < Z_INDEX_FLOOR) {
        maxZ = z;
      }
    }
  } catch {
    // Fallback
  }

  return Math.max(maxZ + 1, Z_INDEX_FLOOR);
}

// ─── Internal: Tag Element Creation ────────────────────────────────────────

function createTagElement(id: number, bounds: BoundingBox): HTMLElement {
  const tag = document.createElement('div');
  tag.className = 'chrome-agent-tag';
  tag.setAttribute('data-tag-num', String(id));
  tag.setAttribute('aria-hidden', 'true');

  // Position relative to document (accounting for scroll)
  tag.style.cssText = `
    position: absolute;
    left: ${bounds.x + window.scrollX}px;
    top: ${bounds.y + window.scrollY}px;
    width: ${Math.max(bounds.width, 24)}px;
    height: ${Math.max(bounds.height, 24)}px;
    pointer-events: none;
    z-index: inherit;
  `;

  // Number badge
  const badge = document.createElement('div');
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

  // Highlight outline
  const outline = document.createElement('div');
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

// ─── Internal: Multi-Strategy Locator ──────────────────────────────────────

function buildMultiStrategyLocator(el: Element, id: number): MultiStrategyLocator {
  return {
    dataTagId: `[data-tag-id="@${id}"]`,
    cssPath: buildCssPath(el),
    attributeSelector: buildAttributeSelector(el),
    textFragment: (el.textContent ?? '').trim().slice(0, 100),
  };
}

function buildCssPath(el: Element): string {
  // Find nearest stable ancestor (has id or data-* attribute)
  let stableAncestor: Element | null = null;
  let current: Element | null = el.parentElement;

  while (current && current !== document.body) {
    if (current.id || Array.from(current.attributes).some((a) => a.name.startsWith('data-'))) {
      stableAncestor = current;
      break;
    }
    current = current.parentElement;
  }

  // Build path from stable ancestor to target
  const parts: string[] = [el.tagName.toLowerCase()];
  let child = el;
  let parent = el.parentElement;

  while (parent && parent !== stableAncestor && parent !== document.body) {
    const siblings = Array.from(parent.children).filter(
      (s) => s.tagName === child.tagName,
    );
    const index = siblings.indexOf(child) + 1;
    parts.unshift(`${child.tagName.toLowerCase()}:nth-child(${index})`);
    child = parent;
    parent = parent.parentElement;
  }

  // Add stable ancestor if found
  const prefix = stableAncestor
    ? stableAncestor.id
      ? `#${CSS.escape(stableAncestor.id)}`
      : `[${Array.from(stableAncestor.attributes).find((a) => a.name.startsWith('data-'))!.name}="${CSS.escape(stableAncestor.getAttribute(stableAncestor.attributes[0].name) ?? '')}"]`
    : 'body';

  return `${prefix} > ${parts.join(' > ')}`;
}

function buildAttributeSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const attrs: string[] = [];

  const type = el.getAttribute('type');
  if (type) attrs.push(`type="${CSS.escape(type)}"`);

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) attrs.push(`aria-label="${CSS.escape(ariaLabel.slice(0, 50))}"`);

  const name = el.getAttribute('name');
  if (name) attrs.push(`name="${CSS.escape(name)}"`);

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) attrs.push(`placeholder="${CSS.escape(placeholder.slice(0, 50))}"`);

  if (attrs.length === 0) {
    // Fall back to nth-child path
    return buildCssPath(el);
  }

  return `${tag}[${attrs.join('][')}]`;
}

function findElementByTextFragment(tagName: string, textFragment: string): Element | null {
  if (!textFragment) return null;

  const elements = document.querySelectorAll(tagName);
  for (const el of elements) {
    if ((el.textContent ?? '').trim().slice(0, 100) === textFragment) {
      return el;
    }
  }
  return null;
}

// ─── Internal: Fingerprint ─────────────────────────────────────────────────

function computeFingerprint(el: Element): string {
  const outer = el.outerHTML.slice(0, 200);
  const rect = el.getBoundingClientRect();
  const rectStr = `${rect.x},${rect.y},${rect.width},${rect.height}`;
  return `${outer}|${rectStr}`;
}

function isInsideCrossOriginIframe(el: Element): boolean {
  try {
    const doc = el.ownerDocument;
    if (doc === document) return false;
    // If we can access the document's location, it's same-origin
    void doc.location.href;
    return false;
  } catch {
    return true; // Cross-origin iframe — can't access
  }
}

function getElementBounds(el: Element): BoundingBox {
  const rect = el.getBoundingClientRect();
  // getBoundingClientRect already accounts for CSS transforms, so no extra work needed
  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

// ─── Internal: Position Sync ───────────────────────────────────────────────

function startPositionSync(): void {
  if (syncRafId !== null) return;

  const sync = (): void => {
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

function stopPositionSync(): void {
  if (syncRafId !== null) {
    cancelAnimationFrame(syncRafId);
    syncRafId = null;
  }
}

// ─── Internal: Tag Integrity Observer ──────────────────────────────────────

function observeTagIntegrity(): void {
  if (mutationObserver) return;

  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node instanceof Element) {
          // Check if any tagged elements were removed
          for (const [id, tag] of activeTags) {
            if (node.contains(tag.element) || node === tag.element) {
              // Element removed — clean up tag
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
    subtree: true,
  });
}

function stopTagIntegrityObserver(): void {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
}
