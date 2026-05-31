// ============================================================================
// Content Filter Pipeline
// Applied to ALL semantic data BEFORE sending to DeepSeek.
// See plan.md Section 5.1 for the full specification.
// ============================================================================

/** PII regex patterns — compiled once at module load. */
const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Email addresses
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[email]' },
  // Chinese mobile phone numbers
  { pattern: /1[3-9]\d{9}/g, replacement: '[phone]' },
  // 13-19 digit consecutive numbers (credit card / account number patterns)
  { pattern: /\b\d{13,19}\b/g, replacement: '[card-number]' },
];

/** Security-sensitive name/id patterns. Matches are replaced with `[filtered]`. */
const SECURITY_NAME_PATTERN = /token|nonce|csrf|session|auth|key|secret|password|verification|credential|__/i;

/** Hidden/password/file input types that must never leave the browser. */
const EXCLUDED_INPUT_TYPES = new Set(['hidden', 'password', 'file']);

// ─── Filter Results ────────────────────────────────────────────────────────

export interface FilterResult {
  /** Whether the element should be included in the semantic output. */
  include: boolean;
  /** Sanitized name attribute (or undefined if excluded). */
  name?: string;
}

// ─── Individual Filters ────────────────────────────────────────────────────

/**
 * Filter 1: Exclude sensitive input elements.
 * - input[type=hidden]
 * - input[type=password]
 * - input[type=file]
 */
export function filterSensitiveInputType(type: string | null): boolean {
  if (!type) return true;
  return !EXCLUDED_INPUT_TYPES.has(type.toLowerCase());
}

/**
 * Filter 2: Sanitize security-sensitive name/id patterns.
 * Returns `[filtered]` if the name matches CSRF/token/session/etc patterns.
 */
export function filterSecurityName(name: string): string {
  if (SECURITY_NAME_PATTERN.test(name)) {
    return '[filtered]';
  }
  return name;
}

/**
 * Filter 3: URL sanitization — retain only origin + pathname.
 * Strips all query parameters and fragment identifiers.
 */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    // If it's not a valid URL, return as-is (could be a relative path)
    // but strip query params and fragment manually
    const qIdx = url.indexOf('?');
    const fIdx = url.indexOf('#');
    let end = url.length;
    if (qIdx >= 0) end = Math.min(end, qIdx);
    if (fIdx >= 0) end = Math.min(end, fIdx);
    return url.slice(0, end);
  }
}

/**
 * Filter 4: PII removal.
 * Replaces email addresses, phone numbers, and card numbers with placeholders.
 */
export function removePII(text: string): string {
  let result = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Filter 5 & 6: Token budget truncation and text normalization.
 * Truncates to approximately `maxChars` characters (roughly maxChars/4 tokens).
 * Normalizes whitespace.
 */
export function truncateText(text: string, maxChars = 8000): string {
  // Normalize whitespace: collapse multiple spaces/newlines
  const normalized = text.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxChars) return normalized;

  // Truncate at word boundary if possible
  const truncated = normalized.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.8) {
    return truncated.slice(0, lastSpace) + '…';
  }
  return truncated + '…';
}

// ─── Composite Filters ─────────────────────────────────────────────────────

/**
 * Apply the full filtering pipeline to an input element's attributes.
 * Returns undefined if the element should be excluded entirely.
 */
export function filterInputElement(
  _tagName: string,
  type: string | null,
  name: string | null,
  placeholder: string | null,
  ariaLabel: string | null,
): FilterResult & { type?: string; placeholder?: string; ariaLabel?: string } {
  // Filter 1: Exclude sensitive input types
  if (!filterSensitiveInputType(type)) {
    return { include: false };
  }

  // Filter 2: Sanitize security names
  const sanitizedName = name ? filterSecurityName(name) : undefined;

  // Only transmit normalized text (plan Filter 6)
  const sanitizedPlaceholder = placeholder ? removePII(truncateText(placeholder, 200)) : undefined;
  const sanitizedAriaLabel = ariaLabel ? removePII(truncateText(ariaLabel, 200)) : undefined;

  return {
    include: true,
    name: sanitizedName,
    type: type ?? undefined,
    placeholder: sanitizedPlaceholder,
    ariaLabel: sanitizedAriaLabel,
  };
}

/**
 * Apply full filtering to a generic text node or element text content.
 */
export function filterTextContent(text: string, maxChars = 200): string {
  const piiFree = removePII(text);
  return truncateText(piiFree, maxChars);
}

/**
 * Apply filtering to an href attribute.
 */
export function filterHref(href: string | null): string | undefined {
  if (!href) return undefined;
  return sanitizeUrl(href);
}

/**
 * Apply filtering to element attribute name.
 */
export function filterAttributeName(name: string): string {
  return filterSecurityName(name);
}

// ─── Token Budget Allocator ─────────────────────────────────────────────────

/** Token budget distribution by semantic category. Total: ~2000 tokens (~8000 chars). */
const TOKEN_BUDGET = {
  title: 500,        // chars
  nav: 800,          // chars
  forms: 2000,       // chars
  interactiveElements: 3000, // chars
  structuralAreas: 1200, // chars
  other: 500,        // chars
};

/**
 * Enforce the token budget across the full semantic structure.
 * Truncates each section proportionally.
 */
export function enforceTokenBudget(structure: {
  title: string;
  navItems: string[];
  formText: string;
  interactiveText: string;
  structuralText: string;
}): typeof structure {
  return {
    title: truncateText(structure.title, TOKEN_BUDGET.title),
    navItems: structure.navItems.map((n) => truncateText(n, 100)),
    formText: truncateText(structure.formText, TOKEN_BUDGET.forms),
    interactiveText: truncateText(structure.interactiveText, TOKEN_BUDGET.interactiveElements),
    structuralText: truncateText(structure.structuralText, TOKEN_BUDGET.structuralAreas),
  };
}

// ─── HTML Text Extraction ──────────────────────────────────────────────────

/**
 * Extract only the normalized text from an element, never raw HTML.
 * This is crucial: raw HTML can contain prompt injection payloads.
 */
export function extractNormalizedText(
  el: Element,
  options?: { maxChars?: number; includeAria?: boolean },
): string {
  const maxChars = options?.maxChars ?? 200;

  // Pseudo-element content (::before / ::after)
  const before = window.getComputedStyle(el, '::before').content;
  const after = window.getComputedStyle(el, '::after').content;
  let pseudoText = '';
  if (before && before !== 'none' && before !== 'normal') {
    pseudoText += before.replace(/^["']|["']$/g, '') + ' ';
  }
  if (after && after !== 'none' && after !== 'normal') {
    pseudoText += after.replace(/^["']|["']$/g, '');
  }

  // Get ONLY text content — strip all HTML tags
  const textContent = (el.textContent ?? '').trim();

  // Combine pseudo-element text with text content
  const combined = (pseudoText + ' ' + textContent).trim();

  return filterTextContent(combined, maxChars);
}

/**
 * Determine if an element is within the viewport.
 */
export function isInViewport(el: Element, viewportHeight: number): boolean {
  const rect = el.getBoundingClientRect();
  // Include elements that are slightly above the fold
  const topMargin = 200;
  return rect.bottom >= -topMargin && rect.top <= viewportHeight + topMargin;
}

/**
 * Determine if an element is genuinely visible (not CSS-hidden).
 */
export function isElementVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    parseFloat(style.opacity) > 0 &&
    !el.hasAttribute('aria-hidden') &&
    // Check if element has dimensions
    el.getBoundingClientRect().width > 0 &&
    el.getBoundingClientRect().height > 0
  );
}
