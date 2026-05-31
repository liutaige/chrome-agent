import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  VALID_ACTIONS,
  isValidAction,
  isValidBaseMessage,
  isValidKey,
  isValidScrollDirection,
} from '../src/shared/messages';

describe('Message Schema', () => {
  describe('PROTOCOL_VERSION', () => {
    it('should be 1', () => {
      expect(PROTOCOL_VERSION).toBe(1);
    });
  });

  describe('VALID_ACTIONS', () => {
    it('should contain exactly 15 actions', () => {
      expect(VALID_ACTIONS).toHaveLength(15);
    });

    it('should include all action types from the plan', () => {
      const expected = [
        'get_page_semantic_structure',
        'extract_text',
        'tag_elements',
        'call_vision_model',
        'execute_click',
        'execute_type',
        'hover',
        'press_key',
        'scroll_page',
        'wait_for',
        'handle_dialog',
        'ask_user',
        'finish_task',
        'navigate_to_url',
        'execute_javascript',
      ];
      expect(VALID_ACTIONS.sort()).toEqual(expected.sort());
    });
  });

  describe('isValidAction', () => {
    it('returns true for valid actions', () => {
      expect(isValidAction('execute_click')).toBe(true);
      expect(isValidAction('get_page_semantic_structure')).toBe(true);
      expect(isValidAction('execute_javascript')).toBe(true);
    });

    it('returns false for invalid actions', () => {
      expect(isValidAction('malicious_action')).toBe(false);
      expect(isValidAction('')).toBe(false);
      expect(isValidAction('executeClick')).toBe(false);
    });
  });

  describe('isValidBaseMessage', () => {
    it('accepts a well-formed message', () => {
      const msg = {
        protocolVersion: 1,
        action: 'execute_click',
        requestId: 'uuid-123',
        tabId: 5,
        element_id: 3,
      };
      expect(isValidBaseMessage(msg)).toBe(true);
    });

    it('rejects null or non-object', () => {
      expect(isValidBaseMessage(null)).toBe(false);
      expect(isValidBaseMessage(undefined)).toBe(false);
      expect(isValidBaseMessage('string')).toBe(false);
    });

    it('rejects wrong protocol version', () => {
      expect(isValidBaseMessage({ protocolVersion: 2, action: 'execute_click', requestId: 'x', tabId: 1 })).toBe(false);
    });

    it('rejects invalid action', () => {
      expect(isValidBaseMessage({ protocolVersion: 1, action: 'delete_everything', requestId: 'x', tabId: 1 })).toBe(false);
    });

    it('rejects missing requestId', () => {
      expect(isValidBaseMessage({ protocolVersion: 1, action: 'execute_click', tabId: 1 })).toBe(false);
    });

    it('rejects negative tabId', () => {
      expect(isValidBaseMessage({ protocolVersion: 1, action: 'execute_click', requestId: 'x', tabId: -1 })).toBe(false);
    });
  });

  describe('isValidKey', () => {
    it('accepts all valid key names', () => {
      const validKeys = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete', 'Control+A', 'Shift+Tab'];
      for (const key of validKeys) {
        expect(isValidKey(key)).toBe(true);
      }
    });

    it('rejects invalid keys', () => {
      expect(isValidKey('F5')).toBe(false);
      expect(isValidKey('Ctrl+C')).toBe(false);
      expect(isValidKey('')).toBe(false);
    });
  });

  describe('isValidScrollDirection', () => {
    it('accepts valid directions', () => {
      expect(isValidScrollDirection('up')).toBe(true);
      expect(isValidScrollDirection('down')).toBe(true);
      expect(isValidScrollDirection('top')).toBe(true);
      expect(isValidScrollDirection('bottom')).toBe(true);
    });

    it('rejects invalid directions', () => {
      expect(isValidScrollDirection('left')).toBe(false);
      expect(isValidScrollDirection('')).toBe(false);
    });
  });
});
