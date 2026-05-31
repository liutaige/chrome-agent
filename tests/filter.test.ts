import { describe, it, expect } from 'vitest';
import {
  filterSensitiveInputType,
  filterSecurityName,
  sanitizeUrl,
  removePII,
  truncateText,
  filterInputElement,
  filterTextContent,
  filterHref,
  isElementVisible,
} from '../src/content/filter';

describe('Content Filter Pipeline', () => {
  describe('filterSensitiveInputType', () => {
    it('excludes hidden inputs', () => {
      expect(filterSensitiveInputType('hidden')).toBe(false);
    });

    it('excludes password inputs', () => {
      expect(filterSensitiveInputType('password')).toBe(false);
    });

    it('excludes file inputs', () => {
      expect(filterSensitiveInputType('file')).toBe(false);
    });

    it('allows text inputs', () => {
      expect(filterSensitiveInputType('text')).toBe(true);
    });

    it('allows null type', () => {
      expect(filterSensitiveInputType(null)).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(filterSensitiveInputType('HIDDEN')).toBe(false);
      expect(filterSensitiveInputType('Password')).toBe(false);
    });
  });

  describe('filterSecurityName', () => {
    it('filters CSRF token names', () => {
      expect(filterSecurityName('csrf_token')).toBe('[filtered]');
      expect(filterSecurityName('csrfmiddlewaretoken')).toBe('[filtered]');
    });

    it('filters nonce names', () => {
      expect(filterSecurityName('nonce')).toBe('[filtered]');
      expect(filterSecurityName('csp_nonce')).toBe('[filtered]');
    });

    it('filters session/verification names', () => {
      expect(filterSecurityName('session_id')).toBe('[filtered]');
      expect(filterSecurityName('verification_token')).toBe('[filtered]');
    });

    it('filters auth/key/secret names', () => {
      expect(filterSecurityName('auth_key')).toBe('[filtered]');
      expect(filterSecurityName('api_secret')).toBe('[filtered]');
      expect(filterSecurityName('encryption_key')).toBe('[filtered]');
    });

    it('filters names starting with __', () => {
      expect(filterSecurityName('__request_token')).toBe('[filtered]');
      expect(filterSecurityName('__internal')).toBe('[filtered]');
    });

    it('allows safe names', () => {
      expect(filterSecurityName('username')).toBe('username');
      expect(filterSecurityName('q')).toBe('q');
      expect(filterSecurityName('search_query')).toBe('search_query');
    });
  });

  describe('sanitizeUrl', () => {
    it('strips query parameters', () => {
      const result = sanitizeUrl('https://example.com/page?a=1&b=2&token=secret');
      expect(result).toBe('https://example.com/page');
    });

    it('strips fragment', () => {
      const result = sanitizeUrl('https://example.com/page#section1');
      expect(result).toBe('https://example.com/page');
    });

    it('strips both query and fragment', () => {
      const result = sanitizeUrl('https://example.com/search?q=test#results');
      expect(result).toBe('https://example.com/search');
    });

    it('handles relative paths', () => {
      const result = sanitizeUrl('/page?ref=homepage');
      expect(result).toBe('/page');
    });

    it('handles invalid URLs gracefully', () => {
      const result = sanitizeUrl('not a url?x=1');
      expect(result).not.toContain('?x=1');
    });
  });

  describe('removePII', () => {
    it('removes email addresses', () => {
      const result = removePII('Contact us at user@example.com for help');
      expect(result).not.toContain('user@example.com');
      expect(result).toContain('[email]');
    });

    it('removes Chinese phone numbers', () => {
      const result = removePII('Phone: 13800138000 for support');
      expect(result).not.toContain('13800138000');
      expect(result).toContain('[phone]');
    });

    it('removes long number sequences (potential card numbers)', () => {
      const result = removePII('Card: 1234567890123456789 payment');
      expect(result).not.toContain('1234567890123456789');
      expect(result).toContain('[card-number]');
    });

    it('does not remove short numbers', () => {
      const result = removePII('Order #12345, price: 99');
      expect(result).toContain('12345');
      expect(result).toContain('99');
    });
  });

  describe('truncateText', () => {
    it('preserves short text', () => {
      const text = 'Short text';
      expect(truncateText(text, 100)).toBe('Short text');
    });

    it('truncates long text', () => {
      const text = 'x'.repeat(200);
      const result = truncateText(text, 100);
      expect(result.length).toBeLessThanOrEqual(103); // 100 + '…'
      expect(result.endsWith('…')).toBe(true);
    });

    it('normalizes whitespace', () => {
      const result = truncateText('  hello   world  \n  test  ');
      expect(result).toBe('hello world test');
    });
  });

  describe('filterInputElement (composite)', () => {
    it('excludes password inputs', () => {
      const result = filterInputElement('input', 'password', 'password', 'Enter password', null);
      expect(result.include).toBe(false);
    });

    it('filters security names on text inputs', () => {
      const result = filterInputElement('input', 'text', 'csrf_token', 'Enter value', null);
      expect(result.include).toBe(true);
      expect(result.name).toBe('[filtered]');
    });

    it('passes through safe inputs', () => {
      const result = filterInputElement('input', 'text', 'username', 'Enter username', 'Username field');
      expect(result.include).toBe(true);
      expect(result.name).toBe('username');
      expect(result.placeholder).toBe('Enter username');
      expect(result.ariaLabel).toBe('Username field');
    });

    it('handles null attributes', () => {
      const result = filterInputElement('button', null, null, null, null);
      expect(result.include).toBe(true);
      expect(result.name).toBeUndefined();
    });
  });

  describe('filterTextContent', () => {
    it('removes PII and truncates', () => {
      const result = filterTextContent('Email: test@example.com, Phone: 13800138000, ' + 'x'.repeat(300), 50);
      expect(result).toContain('[email]');
      expect(result).toContain('[phone]');
      expect(result.length).toBeLessThanOrEqual(53);
    });
  });

  describe('filterHref', () => {
    it('sanitizes full URLs', () => {
      expect(filterHref('https://example.com/page?secret=123')).toBe('https://example.com/page');
    });

    it('returns undefined for null', () => {
      expect(filterHref(null)).toBeUndefined();
    });
  });
});
