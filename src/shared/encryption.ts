// ============================================================================
// API Key Encryption — AES-256-GCM with PBKDF2 Key Derivation
// ============================================================================

// Node.js Buffer type — only available in test environment
declare const Buffer: {
  from(data: Uint8Array | string, encoding?: string): {
    toString(encoding: 'base64'): string;
    buffer: ArrayBuffer;
    byteOffset: number;
    byteLength: number;
  };
} | undefined;

// ─── Constants ─────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_HASH = 'SHA-256';
const PBKDF2_KEY_LENGTH = 256; // bits
const DEK_LENGTH = 32; // bytes (256 bits)
const SALT_LENGTH = 16; // bytes
const GCM_IV_LENGTH = 12; // bytes
const GCM_TAG_LENGTH = 128; // bits (standard for GCM)

const ENCRYPTION_ALGORITHM = 'AES-GCM';
const KEY_WRAP_ALGORITHM = 'AES-KW';

// chrome.storage keys
const STORAGE_KEY_SALT = 'encryption:salt';
const STORAGE_KEY_WRAPPED_DEK = 'encryption:wrapped_dek';
const STORAGE_KEY_DEEPSEEK_API_KEY = 'encryption:deepseek_api_key';
const STORAGE_KEY_DOUBAO_API_KEY = 'encryption:doubao_api_key';
const STORAGE_KEY_DOUBAO_ENDPOINT_ID = 'encryption:doubao_endpoint_id';
const STORAGE_KEY_SESSION_KEYS = 'session:decrypted_keys';

// ─── Crypto Helpers ────────────────────────────────────────────────────────

/** Convert ArrayBuffer or Uint8Array to base64 string. */
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // Use Node.js Buffer when available (test env), fall back to btoa
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert base64 string to ArrayBuffer. */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Use Node.js Buffer when available (test env), fall back to atob
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  return buffer;
}

/** Generate cryptographically random bytes. */
function generateRandomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length)) as Uint8Array<ArrayBuffer>;
}

// ─── Key Derivation ────────────────────────────────────────────────────────

/**
 * Derive the Key Encryption Key (KEK) from the extension ID + random salt.
 *
 * chrome.runtime.id is used as the password input to PBKDF2. It is NOT a
 * secret (any extension or page can read it), so security depends on:
 *   - Random salt (16 bytes) preventing rainbow table attacks
 *   - 600,000 SHA-256 iterations making brute force prohibitively expensive
 *
 * Returns a CryptoKey suitable for AES-KW wrapping/unwrapping.
 */
async function deriveKEK(salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(chrome.runtime.id);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    {
      name: KEY_WRAP_ALGORITHM,
      length: PBKDF2_KEY_LENGTH,
    },
    false, // not extractable
    ['wrapKey', 'unwrapKey'],
  );
}

// ─── DEK Management ────────────────────────────────────────────────────────

/**
 * Generate a new random Data Encryption Key (DEK).
 */
async function generateDEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    {
      name: ENCRYPTION_ALGORITHM,
      length: DEK_LENGTH * 8, // bits
    },
    true, // extractable — we need to wrap it
    ['encrypt', 'decrypt'],
  );
}

/**
 * Wrap (encrypt) a DEK with the KEK using AES-KW.
 */
async function wrapDEK(dek: CryptoKey, kek: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.wrapKey('raw', dek, kek, {
    name: KEY_WRAP_ALGORITHM,
  });
}

/**
 * Unwrap (decrypt) a DEK with the KEK using AES-KW.
 */
async function unwrapDEK(wrappedDek: ArrayBuffer, kek: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    wrappedDek,
    kek,
    {
      name: KEY_WRAP_ALGORITHM,
    },
    {
      name: ENCRYPTION_ALGORITHM,
      length: DEK_LENGTH * 8,
    },
    false, // not extractable after unwrapping
    ['encrypt', 'decrypt'],
  );
}

// ─── API Key Encryption / Decryption ───────────────────────────────────────

/**
 * Encrypt an API key with AES-256-GCM.
 * Returns { ciphertext, iv } both as base64 strings.
 */
async function encryptWithDEK(plaintext: string, dek: CryptoKey): Promise<{ ciphertext: string; iv: string }> {
  const iv = generateRandomBytes(GCM_IV_LENGTH);
  const encoded = new TextEncoder().encode(plaintext);

  const encrypted = await crypto.subtle.encrypt(
    {
      name: ENCRYPTION_ALGORITHM,
      iv: iv,
      tagLength: GCM_TAG_LENGTH,
    },
    dek,
    encoded,
  );

  return {
    ciphertext: arrayBufferToBase64(encrypted),
    iv: arrayBufferToBase64(iv),
  };
}

/**
 * Decrypt an API key with AES-256-GCM.
 */
async function decryptWithDEK(
  ciphertextB64: string,
  ivB64: string,
  dek: CryptoKey,
): Promise<string> {
  const ciphertext = base64ToArrayBuffer(ciphertextB64);
  const iv = base64ToArrayBuffer(ivB64);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: ENCRYPTION_ALGORITHM,
      iv,
      tagLength: GCM_TAG_LENGTH,
    },
    dek,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface KeyStorageFormat {
  ciphertext: string; // base64
  iv: string; // base64
}

/**
 * Initialize the encryption system.
 * Generates a new salt + DEK if not already present in storage.
 * Must be called once during extension installation/startup.
 *
 * This is idempotent — if keys already exist, it's a no-op.
 */
export async function initializeEncryption(): Promise<void> {
  // Check if salt already exists
  const existing = await chrome.storage.local.get([STORAGE_KEY_SALT, STORAGE_KEY_WRAPPED_DEK]);

  if (existing[STORAGE_KEY_SALT] && existing[STORAGE_KEY_WRAPPED_DEK]) {
    // Already initialized
    return;
  }

  // Generate new salt
  const salt = generateRandomBytes(SALT_LENGTH);

  // Generate new DEK
  const dek = await generateDEK();

  // Derive KEK from extension ID + salt
  const kek = await deriveKEK(salt);

  // Wrap DEK with KEK
  const wrappedDek = await wrapDEK(dek, kek);

  // Store salt + wrapped DEK in chrome.storage.local
  await chrome.storage.local.set({
    [STORAGE_KEY_SALT]: arrayBufferToBase64(salt),
    [STORAGE_KEY_WRAPPED_DEK]: arrayBufferToBase64(wrappedDek),
  });

  console.log('[encryption] Encryption system initialized. DEK generated and wrapped.');
}

/**
 * Store an API key encrypted.
 *
 * @param keyType - 'deepseek' or 'doubao'
 * @param apiKey - The plaintext API key to encrypt and store
 */
export async function storeApiKey(keyType: 'deepseek' | 'doubao', apiKey: string): Promise<void> {
  const dek = await loadDEK();
  if (!dek) {
    throw new Error('Encryption not initialized. Call initializeEncryption() first.');
  }

  const { ciphertext, iv } = await encryptWithDEK(apiKey, dek);

  const storageKey = keyType === 'deepseek' ? STORAGE_KEY_DEEPSEEK_API_KEY : STORAGE_KEY_DOUBAO_API_KEY;

  await chrome.storage.local.set({
    [storageKey]: { ciphertext, iv } satisfies KeyStorageFormat,
  });

  console.log(`[encryption] ${keyType} API key stored (encrypted).`);
}

/**
 * Load an API key (decrypted) from storage.
 *
 * The decrypted key is cached in chrome.storage.session for the lifetime
 * of the browser session.
 *
 * @param keyType - 'deepseek' or 'doubao'
 * @returns The decrypted API key, or null if not found
 */
export async function loadApiKey(keyType: 'deepseek' | 'doubao'): Promise<string | null> {
  // Try session cache first
  const sessionKeys = await chrome.storage.session.get([STORAGE_KEY_SESSION_KEYS]);
  const sessionData = sessionKeys[STORAGE_KEY_SESSION_KEYS] as Record<string, string> | undefined;
  if (sessionData?.[keyType]) {
    return sessionData[keyType];
  }

  // Load from local storage and decrypt
  const dek = await loadDEK();
  if (!dek) {
    console.warn('[encryption] DEK not available — encryption may not be initialized');
    return null;
  }

  const storageKey = keyType === 'deepseek' ? STORAGE_KEY_DEEPSEEK_API_KEY : STORAGE_KEY_DOUBAO_API_KEY;

  const stored = await chrome.storage.local.get([storageKey]);
  const keyData = stored[storageKey] as KeyStorageFormat | undefined;

  if (!keyData?.ciphertext || !keyData?.iv) {
    return null;
  }

  try {
    const plaintext = await decryptWithDEK(keyData.ciphertext, keyData.iv, dek);

    // Cache in session storage
    const updatedSession: Record<string, string> = { ...sessionData, [keyType]: plaintext };
    await chrome.storage.session.set({ [STORAGE_KEY_SESSION_KEYS]: updatedSession });

    return plaintext;
  } catch (err) {
    console.error(`[encryption] Failed to decrypt ${keyType} API key:`, err);
    return null;
  }
}

/**
 * Remove a stored API key.
 */
export async function removeApiKey(keyType: 'deepseek' | 'doubao'): Promise<void> {
  const storageKey = keyType === 'deepseek' ? STORAGE_KEY_DEEPSEEK_API_KEY : STORAGE_KEY_DOUBAO_API_KEY;
  await chrome.storage.local.remove([storageKey]);

  // Also clear from session cache
  const sessionKeys = await chrome.storage.session.get([STORAGE_KEY_SESSION_KEYS]);
  const sessionData = sessionKeys[STORAGE_KEY_SESSION_KEYS] as Record<string, string> | undefined;
  if (sessionData) {
    delete sessionData[keyType];
    await chrome.storage.session.set({ [STORAGE_KEY_SESSION_KEYS]: sessionData });
  }

  console.log(`[encryption] ${keyType} API key removed.`);
}

/**
 * Check if an API key is stored for the given type.
 */
export async function hasApiKey(keyType: 'deepseek' | 'doubao'): Promise<boolean> {
  const key = await loadApiKey(keyType);
  return key !== null && key.length > 0;
}

// ─── Doubao Endpoint ID (unencrypted — not a secret, like a model name) ───

/**
 * Store the Doubao endpoint ID (ep-xxx).
 * Not encrypted — endpoint IDs are model identifiers, not secrets.
 */
export async function storeDoubaoEndpointId(endpointId: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_DOUBAO_ENDPOINT_ID]: endpointId });
}

/** Load the Doubao endpoint ID. */
export async function loadDoubaoEndpointId(): Promise<string | null> {
  const data = await chrome.storage.local.get([STORAGE_KEY_DOUBAO_ENDPOINT_ID]);
  return (data[STORAGE_KEY_DOUBAO_ENDPOINT_ID] as string) ?? null;
}

/** Check if a Doubao endpoint ID is configured. */
export async function hasDoubaoEndpointId(): Promise<boolean> {
  const id = await loadDoubaoEndpointId();
  return id !== null && id.startsWith('ep-');
}

/** Remove the Doubao endpoint ID. */
export async function removeDoubaoEndpointId(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEY_DOUBAO_ENDPOINT_ID]);
}

// ─── Internal: Load DEK ────────────────────────────────────────────────────

async function loadDEK(): Promise<CryptoKey | null> {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_SALT, STORAGE_KEY_WRAPPED_DEK]);

    const saltB64 = stored[STORAGE_KEY_SALT] as string | undefined;
    const wrappedDekB64 = stored[STORAGE_KEY_WRAPPED_DEK] as string | undefined;

    if (!saltB64 || !wrappedDekB64) {
      return null;
    }

    const salt = new Uint8Array(base64ToArrayBuffer(saltB64));
    const wrappedDek = base64ToArrayBuffer(wrappedDekB64);

    const kek = await deriveKEK(salt);
    const dek = await unwrapDEK(wrappedDek, kek);

    return dek;
  } catch (err) {
    console.error('[encryption] Failed to load DEK:', err);
    return null;
  }
}

// ─── Re-encryption (for key rotation) ──────────────────────────────────────

/**
 * Re-encrypt all stored API keys with a new DEK.
 * Useful for key rotation or when the extension ID changes (development).
 *
 * Process:
 *   1. Decrypt existing keys with old DEK
 *   2. Generate new salt + DEK
 *   3. Re-encrypt keys with new DEK
 */
export async function rotateEncryption(): Promise<void> {
  // Load existing keys
  const existingDeepseek = await loadApiKey('deepseek');
  const existingDoubao = await loadApiKey('doubao');

  // Remove old encryption artifacts
  await chrome.storage.local.remove([
    STORAGE_KEY_SALT,
    STORAGE_KEY_WRAPPED_DEK,
    STORAGE_KEY_DEEPSEEK_API_KEY,
    STORAGE_KEY_DOUBAO_API_KEY,
  ]);

  // Re-initialize
  await initializeEncryption();

  // Re-store keys
  if (existingDeepseek) {
    await storeApiKey('deepseek', existingDeepseek);
  }
  if (existingDoubao) {
    await storeApiKey('doubao', existingDoubao);
  }

  console.log('[encryption] Key rotation complete.');
}

// ─── Integrity Check ───────────────────────────────────────────────────────

/**
 * Verify the encryption system is operational.
 * Returns true if we can successfully derive the KEK and decrypt the DEK.
 */
export async function verifyEncryptionIntegrity(): Promise<boolean> {
  try {
    const dek = await loadDEK();
    if (!dek) return false;

    // Try a test encrypt/decrypt round-trip
    const testString = 'encryption-integrity-test';
    const { ciphertext, iv } = await encryptWithDEK(testString, dek);
    const decrypted = await decryptWithDEK(ciphertext, iv, dek);

    return decrypted === testString;
  } catch {
    return false;
  }
}
