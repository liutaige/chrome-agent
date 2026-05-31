import { describe, it, expect, beforeEach } from 'vitest';

// Encryption tests require the Web Crypto API.
// These tests run only when crypto.subtle is available (Node 19+, or jsdom with proper config).

const hasCrypto = typeof crypto !== 'undefined' && crypto.subtle !== undefined;

describe('Encryption', () => {
  beforeEach(async () => {
    if (!hasCrypto) return;
    // Clear storage before each test
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  });

  describe('initializeEncryption', () => {
    it('should initialize encryption system when crypto is available', async () => {
      if (!hasCrypto) {
        console.warn('Skipping encryption test: Web Crypto API not available');
        return;
      }

      const { initializeEncryption } = await import('../src/shared/encryption');

      // Should not throw
      await initializeEncryption();

      // Verify salt and wrapped DEK were stored
      const stored = await chrome.storage.local.get(['encryption:salt', 'encryption:wrapped_dek']);
      expect(stored['encryption:salt']).toBeDefined();
      expect(stored['encryption:wrapped_dek']).toBeDefined();
    });

    it('should be idempotent', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption } = await import('../src/shared/encryption');

      await initializeEncryption();

      // Get the initial values
      const first = await chrome.storage.local.get(['encryption:salt', 'encryption:wrapped_dek']);

      // Call again
      await initializeEncryption();

      const second = await chrome.storage.local.get(['encryption:salt', 'encryption:wrapped_dek']);

      // Should be unchanged (idempotent)
      expect(first['encryption:salt']).toBe(second['encryption:salt']);
      expect(first['encryption:wrapped_dek']).toBe(second['encryption:wrapped_dek']);
    });
  });

  describe('storeApiKey / loadApiKey', () => {
    it('should encrypt and decrypt an API key', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption, storeApiKey, loadApiKey } = await import('../src/shared/encryption');

      await initializeEncryption();
      await storeApiKey('deepseek', 'sk-test-api-key-12345');

      const decrypted = await loadApiKey('deepseek');
      expect(decrypted).toBe('sk-test-api-key-12345');
    });

    it('should encrypt and decrypt doubao key', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption, storeApiKey, loadApiKey } = await import('../src/shared/encryption');

      await initializeEncryption();
      await storeApiKey('doubao', 'doubao-test-key-67890');

      const decrypted = await loadApiKey('doubao');
      expect(decrypted).toBe('doubao-test-key-67890');
    });

    it('should store keys separately', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption, storeApiKey, loadApiKey } = await import('../src/shared/encryption');

      await initializeEncryption();
      await storeApiKey('deepseek', 'ds-key');
      await storeApiKey('doubao', 'db-key');

      // Both should be retrievable independently
      expect(await loadApiKey('deepseek')).toBe('ds-key');
      expect(await loadApiKey('doubao')).toBe('db-key');
    });

    it('should return null for non-existent key', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption, loadApiKey } = await import('../src/shared/encryption');

      await initializeEncryption();
      const result = await loadApiKey('deepseek');
      expect(result).toBeNull();
    });

    it('should throw when storing before initialization', async () => {
      if (!hasCrypto) return;

      const { storeApiKey } = await import('../src/shared/encryption');
      await expect(storeApiKey('deepseek', 'key')).rejects.toThrow('Encryption not initialized');
    });
  });

  describe('removeApiKey', () => {
    it('should remove a stored key', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption, storeApiKey, loadApiKey, removeApiKey } = await import('../src/shared/encryption');

      await initializeEncryption();
      await storeApiKey('deepseek', 'sk-test');
      expect(await loadApiKey('deepseek')).toBe('sk-test');

      await removeApiKey('deepseek');
      expect(await loadApiKey('deepseek')).toBeNull();
    });
  });

  describe('hasApiKey', () => {
    it('returns true when key is stored', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption, storeApiKey, hasApiKey } = await import('../src/shared/encryption');

      await initializeEncryption();
      expect(await hasApiKey('deepseek')).toBe(false);

      await storeApiKey('deepseek', 'sk-test');
      expect(await hasApiKey('deepseek')).toBe(true);
    });
  });

  describe('verifyEncryptionIntegrity', () => {
    it('returns true after initialization', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption, verifyEncryptionIntegrity } = await import('../src/shared/encryption');

      await initializeEncryption();
      const ok = await verifyEncryptionIntegrity();
      expect(ok).toBe(true);
    });
  });

  describe('rotateEncryption', () => {
    it('preserves keys after rotation', async () => {
      if (!hasCrypto) return;

      const { initializeEncryption, storeApiKey, loadApiKey, rotateEncryption } = await import('../src/shared/encryption');

      await initializeEncryption();
      await storeApiKey('deepseek', 'original-key');
      await storeApiKey('doubao', 'doubao-key');

      await rotateEncryption();

      expect(await loadApiKey('deepseek')).toBe('original-key');
      expect(await loadApiKey('doubao')).toBe('doubao-key');
    });
  });
});
