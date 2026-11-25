import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let cachedEphemeralMasterKey = null;

/**
 * Resolves the master key used to encrypt/decrypt user exchange API credentials.
 * - LIVE_AUTO_TRADE strictly requires an explicit COMMERCIAL_MASTER_KEY >= 32 characters.
 * - Non-live modes accept an explicit key >= 16 characters, or fall back to a cached
 *   process-local 32-byte random ephemeral key so Paper/Demo/dev works out-of-the-box.
 */
export function resolveVaultMasterKey(config, { forLiveAutoTrade = false } = {}) {
  const explicit = typeof config?.commercialMasterKey === 'string'
    ? config.commercialMasterKey
    : (typeof config?.COMMERCIAL_MASTER_KEY === 'string' ? config.COMMERCIAL_MASTER_KEY : '');

  if (forLiveAutoTrade) {
    if (explicit.length < 32) {
      throw new Error('COMMERCIAL_MASTER_KEY (>= 32 chars) required for LIVE_AUTO_TRADE');
    }
    return { key: explicit, ephemeral: false };
  }

  if (explicit.length >= 16) {
    return { key: explicit, ephemeral: false };
  }

  if (!cachedEphemeralMasterKey) {
    cachedEphemeralMasterKey = crypto.randomBytes(32).toString('hex');
  }
  return { key: cachedEphemeralMasterKey, ephemeral: true };
}

/**
 * Masks an exchange API key without revealing the secret or full public key.
 */
export function maskApiKey(apiKey) {
  if (typeof apiKey !== 'string') return '****';
  const s = apiKey.trim();
  if (!s || s.length <= 4) return '****';
  if (s.length <= 8) return `****${s.slice(-2)}`;
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/**
 * Encrypts an API credential object using AES-256-GCM with scrypt key derivation
 * and AAD binding (typically `subscriberId|exchange`).
 */
export function encryptCredentials(credsObj, masterKey, aad = '') {
  assert.ok(credsObj && typeof credsObj === 'object' && !Array.isArray(credsObj),
    'credsObj must be a plain object');
  assert.ok(
    (typeof masterKey === 'string' && masterKey.length > 0) || Buffer.isBuffer(masterKey),
    'masterKey must be non-empty',
  );

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const derivedKey = crypto.scryptSync(masterKey, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const aadBuf = Buffer.from(String(aad ?? ''), 'utf8');
  cipher.setAAD(aadBuf);

  const plaintext = Buffer.from(JSON.stringify(credsObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    alg: 'aes-256-gcm',
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    tagHex: tag.toString('hex'),
    ciphertextHex: ciphertext.toString('hex'),
    keyMask: maskApiKey(credsObj.apiKey),
  };
}

/**
 * Decrypts and authenticates an encrypted credential envelope.
 * Throws on tampered ciphertext, authTag, salt, IV, wrong masterKey, or mismatched AAD.
 */
export function decryptCredentials(envelope, masterKey, aad = '') {
  assert.ok(envelope && typeof envelope === 'object', 'Invalid encrypted credential envelope');
  assert.equal(envelope.version, 1, 'Unsupported vault envelope version');
  assert.equal(envelope.alg, 'aes-256-gcm', 'Unsupported vault cipher algorithm');
  assert.ok(
    (typeof masterKey === 'string' && masterKey.length > 0) || Buffer.isBuffer(masterKey),
    'masterKey must be non-empty',
  );

  for (const [name, hexLen] of [['saltHex', 32], ['ivHex', 24], ['tagHex', 32]]) {
    const val = envelope[name];
    assert.ok(typeof val === 'string' && val.length === hexLen && /^[0-9a-f]+$/i.test(val),
      `Invalid ${name} in vault envelope`);
  }
  assert.ok(
    typeof envelope.ciphertextHex === 'string' && envelope.ciphertextHex.length >= 2 &&
    envelope.ciphertextHex.length % 2 === 0 && /^[0-9a-f]+$/i.test(envelope.ciphertextHex),
    'Invalid ciphertextHex in vault envelope',
  );

  const salt = Buffer.from(envelope.saltHex, 'hex');
  const iv = Buffer.from(envelope.ivHex, 'hex');
  const tag = Buffer.from(envelope.tagHex, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertextHex, 'hex');

  const derivedKey = crypto.scryptSync(masterKey, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
  decipher.setAAD(Buffer.from(String(aad ?? ''), 'utf8'));
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
