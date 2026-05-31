import { describe, it, expect } from 'vitest';
import { validateCode, createSandboxedExecutor } from '../src/shared/sandbox';

describe('Sandbox Code Validation', () => {
  describe('validateCode', () => {
    it('rejects empty code', () => {
      expect(validateCode('')).toEqual({ valid: false, reason: 'Code is empty' });
      expect(validateCode('  ')).toEqual({ valid: false, reason: 'Code is empty' });
    });

    it('accepts safe DOM queries', () => {
      expect(validateCode('document.querySelector("h1")').valid).toBe(true);
      expect(validateCode('document.querySelectorAll(".item")').valid).toBe(true);
      expect(validateCode('document.getElementById("main")').valid).toBe(true);
      expect(validateCode('element.getBoundingClientRect()').valid).toBe(true);
      expect(validateCode('window.getComputedStyle(el)').valid).toBe(true);
      expect(validateCode('window.innerWidth').valid).toBe(true);
      expect(validateCode('window.devicePixelRatio').valid).toBe(true);
      expect(validateCode('document.getSelection()').valid).toBe(true);
      expect(validateCode('el.closest(".container")').valid).toBe(true);
      expect(validateCode('el.matches(".active")').valid).toBe(true);
    });

    it('blocks innerHTML assignment', () => {
      const result = validateCode('el.innerHTML = "<span>evil</span>"');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('innerHTML');
    });

    it('blocks textContent assignment', () => {
      const result = validateCode('el.textContent = "modified"');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('textContent');
    });

    it('blocks value assignment', () => {
      const result = validateCode('input.value = "injected"');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('value assignment');
    });

    it('blocks classList modification', () => {
      const result = validateCode('el.classList.add("danger")');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('classList');
    });

    it('blocks setAttribute calls', () => {
      const result = validateCode('el.setAttribute("data-x", "y")');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('setAttribute');
    });

    it('blocks removeAttribute calls', () => {
      const result = validateCode('el.removeAttribute("disabled")');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('removeAttribute');
    });

    it('blocks DOM append operations', () => {
      expect(validateCode('parent.appendChild(child)').valid).toBe(false);
      expect(validateCode('parent.insertBefore(child, ref)').valid).toBe(false);
    });

    it('blocks DOM removal operations', () => {
      expect(validateCode('el.remove()').valid).toBe(false);
      expect(validateCode('parent.removeChild(child)').valid).toBe(false);
    });

    it('blocks click and focus calls', () => {
      expect(validateCode('el.click()').valid).toBe(false);
      expect(validateCode('el.focus()').valid).toBe(false);
      expect(validateCode('el.blur()').valid).toBe(false);
    });

    it('blocks dispatchEvent', () => {
      expect(validateCode('el.dispatchEvent(new Event("click"))').valid).toBe(false);
    });

    it('blocks fetch and XHR', () => {
      expect(validateCode('fetch("https://evil.com")').valid).toBe(false);
      expect(validateCode('new XMLHttpRequest()').valid).toBe(false);
    });

    it('blocks WebSocket', () => {
      expect(validateCode('new WebSocket("wss://evil.com")').valid).toBe(false);
    });

    it('blocks navigator.sendBeacon', () => {
      expect(validateCode('navigator.sendBeacon("/log", data)').valid).toBe(false);
    });

    it('blocks eval and new Function', () => {
      expect(validateCode('eval("1+1")').valid).toBe(false);
      expect(validateCode('new Function("return 1")').valid).toBe(false);
    });

    it('blocks setTimeout/setInterval with string args', () => {
      expect(validateCode('setTimeout("alert(1)", 100)').valid).toBe(false);
      expect(validateCode('setInterval("alert(1)", 1000)').valid).toBe(false);
    });

    it('blocks dynamic import', () => {
      expect(validateCode('import("./module")').valid).toBe(false);
    });

    it('blocks storage access', () => {
      expect(validateCode('localStorage.getItem("key")').valid).toBe(false);
      expect(validateCode('sessionStorage.setItem("k", "v")').valid).toBe(false);
      expect(validateCode('document.cookie').valid).toBe(false);
    });

    it('blocks chrome.* API access', () => {
      expect(validateCode('chrome.storage.local.get("k")').valid).toBe(false);
      expect(validateCode('browser.runtime.sendMessage({})').valid).toBe(false);
    });

    it('blocks scroll manipulation', () => {
      expect(validateCode('window.scrollTo(0, 100)').valid).toBe(false);
      expect(validateCode('el.scrollIntoView()').valid).toBe(false);
    });

    it('blocks Event constructors', () => {
      expect(validateCode('new Event("custom")').valid).toBe(false);
      expect(validateCode('new CustomEvent("custom")').valid).toBe(false);
    });

    it('accepts complex but safe queries', () => {
      const safe = `
        const headings = document.querySelectorAll('h1, h2, h3');
        const results = [];
        for (const h of headings) {
          const rect = h.getBoundingClientRect();
          results.push({
            text: h.textContent,
            tag: h.tagName,
            visible: rect.width > 0 && rect.height > 0,
          });
        }
        results;
      `;
      // NOTE: this code uses textContent (read), not textContent= (write)
      // The regex pattern catches .textContent\s*= so read access is OK
      expect(validateCode(safe).valid).toBe(true);
    });
  });

  describe('createSandboxedExecutor', () => {
    it('wraps code in a self-executing function', () => {
      const wrapped = createSandboxedExecutor('return 42');
      expect(wrapped).toContain('sandboxedExecution');
      expect(wrapped).toContain('return 42');
      expect(wrapped).toContain('try {');
      expect(wrapped).toContain('catch');
    });

    it('returns timing information', () => {
      const wrapped = createSandboxedExecutor('return document.title');
      expect(wrapped).toContain('performance.now()');
      expect(wrapped).toContain('durationMs');
    });
  });
});
