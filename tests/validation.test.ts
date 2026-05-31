import { describe, it, expect } from 'vitest';
import {
  validateSender,
  validateBaseMessage,
  validateParameters,
  validateMessage,
} from '../src/shared/validation';

const EXTENSION_ID = 'test-extension-id-abcdef';

function makeSender(overrides?: Partial<chrome.runtime.MessageSender>): chrome.runtime.MessageSender {
  return {
    id: EXTENSION_ID,
    url: 'https://example.com',
    origin: 'https://example.com',
    ...overrides,
  } as chrome.runtime.MessageSender;
}

describe('Message Validation Layer', () => {
  describe('validateSender', () => {
    it('accepts messages from own extension', () => {
      const result = validateSender(makeSender());
      expect(result.valid).toBe(true);
    });

    it('rejects messages from other extensions', () => {
      const result = validateSender(makeSender({ id: 'other-extension-id' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Untrusted sender');
    });
  });

  describe('validateBaseMessage', () => {
    it('accepts a valid base message', () => {
      const msg = {
        protocolVersion: 1,
        action: 'execute_click',
        requestId: 'req-001',
        tabId: 1,
      };
      const result = validateBaseMessage(msg);
      expect(result.valid).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('rejects non-object messages', () => {
      const result = validateBaseMessage(null);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not an object');
    });

    it('rejects wrong protocol version', () => {
      const result = validateBaseMessage({ protocolVersion: 99, action: 'hover', requestId: 'r', tabId: 1 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Protocol version');
    });

    it('rejects unknown action', () => {
      const result = validateBaseMessage({ protocolVersion: 1, action: 'steal_data', requestId: 'r', tabId: 1 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('rejects empty requestId', () => {
      const result = validateBaseMessage({ protocolVersion: 1, action: 'hover', requestId: '', tabId: 1 });
      expect(result.valid).toBe(false);
    });

    it('rejects negative tabId', () => {
      const result = validateBaseMessage({ protocolVersion: 1, action: 'hover', requestId: 'r', tabId: -5 });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateParameters', () => {
    it('validateParameters - get_page_semantic_structure needs no params', () => {
      const msg = { protocolVersion: 1, action: 'get_page_semantic_structure' as const, requestId: 'r', tabId: 1 };
      const result = validateParameters(msg);
      expect(result.valid).toBe(true);
    });

    it('validateParameters - tag_elements requires valid selector', () => {
      const msg = { protocolVersion: 1, action: 'tag_elements' as const, requestId: 'r', tabId: 1, selector: 'input, button' };
      const result = validateParameters(msg);
      expect(result.valid).toBe(true);
    });

    it('validateParameters - tag_elements rejects empty selector', () => {
      const msg = { protocolVersion: 1, action: 'tag_elements' as const, requestId: 'r', tabId: 1, selector: '' };
      const result = validateParameters(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('validateParameters - tag_elements rejects too-long selector', () => {
      const msg = { protocolVersion: 1, action: 'tag_elements' as const, requestId: 'r', tabId: 1, selector: 'x'.repeat(501) };
      const result = validateParameters(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('validateParameters - tag_elements rejects dangerous pseudo-classes', () => {
      const msg = { protocolVersion: 1, action: 'tag_elements' as const, requestId: 'r', tabId: 1, selector: 'a:visited' };
      const result = validateParameters(msg);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('dangerous pseudo-classes');
    });

    it('validateParameters - execute_click requires valid element_id', () => {
      const valid = { protocolVersion: 1, action: 'execute_click' as const, requestId: 'r', tabId: 1, element_id: 3 };
      expect(validateParameters(valid).valid).toBe(true);

      const negative = { protocolVersion: 1, action: 'execute_click' as const, requestId: 'r', tabId: 1, element_id: -1 };
      expect(validateParameters(negative).valid).toBe(false);

      const float = { protocolVersion: 1, action: 'execute_click' as const, requestId: 'r', tabId: 1, element_id: 1.5 };
      expect(validateParameters(float).valid).toBe(false);
    });

    it('validateParameters - execute_type validates text length', () => {
      const valid = { protocolVersion: 1, action: 'execute_type' as const, requestId: 'r', tabId: 1, element_id: 1, text: 'hello' };
      expect(validateParameters(valid).valid).toBe(true);

      const tooLong = { protocolVersion: 1, action: 'execute_type' as const, requestId: 'r', tabId: 1, element_id: 1, text: 'x'.repeat(10001) };
      expect(validateParameters(tooLong).valid).toBe(false);
    });

    it('validateParameters - press_key validates key name', () => {
      const valid = { protocolVersion: 1, action: 'press_key' as const, requestId: 'r', tabId: 1, key: 'Enter' };
      expect(validateParameters(valid).valid).toBe(true);

      const invalid = { protocolVersion: 1, action: 'press_key' as const, requestId: 'r', tabId: 1, key: 'Ctrl+Alt+Del' };
      expect(validateParameters(invalid).valid).toBe(false);
    });

    it('validateParameters - scroll_page validates direction', () => {
      expect(validateParameters({ protocolVersion: 1, action: 'scroll_page' as const, requestId: 'r', tabId: 1, direction: 'up' }).valid).toBe(true);
      expect(validateParameters({ protocolVersion: 1, action: 'scroll_page' as const, requestId: 'r', tabId: 1, direction: 'left' }).valid).toBe(false);
    });

    it('validateParameters - wait_for requires at least one condition', () => {
      const valid = { protocolVersion: 1, action: 'wait_for' as const, requestId: 'r', tabId: 1, condition: { network_idle: true } };
      expect(validateParameters(valid).valid).toBe(true);

      const empty = { protocolVersion: 1, action: 'wait_for' as const, requestId: 'r', tabId: 1, condition: {} };
      expect(validateParameters(empty).valid).toBe(false);
    });

    it('validateParameters - ask_user validates question', () => {
      const valid = { protocolVersion: 1, action: 'ask_user' as const, requestId: 'r', tabId: 1, question: '确认继续？' };
      expect(validateParameters(valid).valid).toBe(true);

      const tooLong = { protocolVersion: 1, action: 'ask_user' as const, requestId: 'r', tabId: 1, question: 'x'.repeat(2001) };
      expect(validateParameters(tooLong).valid).toBe(false);
    });

    it('validateParameters - execute_javascript validates code', () => {
      const valid = { protocolVersion: 1, action: 'execute_javascript' as const, requestId: 'r', tabId: 1, code: 'document.querySelector("h1")' };
      expect(validateParameters(valid).valid).toBe(true);

      const tooLong = { protocolVersion: 1, action: 'execute_javascript' as const, requestId: 'r', tabId: 1, code: 'x'.repeat(5001) };
      expect(validateParameters(tooLong).valid).toBe(false);
    });
  });

  describe('validateMessage (full pipeline)', () => {
    it('passes a fully valid message through all layers', () => {
      const msg = {
        protocolVersion: 1,
        action: 'execute_click',
        requestId: 'req-001',
        tabId: 5,
        element_id: 3,
      };
      const result = validateMessage(msg, makeSender());
      expect(result.valid).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('fails at sender check for untrusted sender', () => {
      const result = validateMessage(
        { protocolVersion: 1, action: 'hover', requestId: 'r', tabId: 1 },
        makeSender({ id: 'evil-extension' }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Untrusted');
    });

    it('fails at base message check for wrong protocol', () => {
      const result = validateMessage(
        { protocolVersion: 999, action: 'hover', requestId: 'r', tabId: 1 },
        makeSender(),
      );
      expect(result.valid).toBe(false);
    });

    it('fails at parameter check for bad params', () => {
      const result = validateMessage(
        { protocolVersion: 1, action: 'execute_click', requestId: 'r', tabId: 1, element_id: 'not_a_number' },
        makeSender(),
      );
      expect(result.valid).toBe(false);
    });
  });
});
