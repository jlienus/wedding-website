'use strict';

// Field-level encryption + blind-index helpers for RSVP PII at rest.
//
// Threat model
// ------------
// Azure Storage Service Encryption (SSE) already protects data at rest at the
// disk layer. This module adds an additional layer that protects against
// compromise of the storage account key itself: an attacker with the account
// key can read row contents directly, but ciphertext is opaque without the
// field key (which is held only in SWA app settings, not in the storage
// account).
//
// Why self-managed keys (not Key Vault)
// -------------------------------------
// Azure Static Web Apps Free tier does not support Managed Identity for
// managed functions (see scripts/rotate-aoai-key.ps1 header for context).
// Without an MI we can't authenticate to Key Vault from the function, so
// we manage the symmetric key as a SWA app setting and rotate it on a
// schedule -- the same pattern already in use for the AOAI key.
//
// Algorithms
// ----------
// * Field cipher: AES-256-GCM with a 96-bit random IV per encryption and a
//   128-bit auth tag. Random IV space is safe well past our scale (<<2^32
//   encryptions per key per NIST SP 800-38D).
// * Blind index: HMAC-SHA256 with a per-field subkey derived via HKDF-SHA256
//   from RSVP_BLIND_INDEX_KEY. Subkey-per-field prevents cross-field index
//   correlation if the master is ever leaked.
// * Wrap format: `enc:v1:a256gcm:<keyId8>:<iv_b64>:<ct_b64>:<tag_b64>`.
//   - `v1` is the envelope version (for future format changes).
//   - `a256gcm` is the cipher (for crypto agility).
//   - `keyId8` is the first 8 hex chars of SHA-256 of the raw key bytes; lets
//     decryption disambiguate CURRENT vs PREVIOUS during a rotation window.
//
// Rotation model
// --------------
// At rest we keep two named keys: CURRENT (always used for new writes) and
// PREVIOUS (optional, only set during a rotation window). decryptField()
// matches the ciphertext's keyId against both and picks the right one. Once
// every row has been re-encrypted under CURRENT, the rotation script clears
// PREVIOUS from app settings.

const crypto = require('crypto');

const ENV_KEY_CURRENT = 'RSVP_FIELD_KEY_CURRENT';
const ENV_KEY_PREVIOUS = 'RSVP_FIELD_KEY_PREVIOUS';
const ENV_BLIND_INDEX = 'RSVP_BLIND_INDEX_KEY';

const CIPHER_PREFIX = 'enc:v1:a256gcm:';
const IV_LENGTH = 12; // 96 bits, GCM standard
const TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

let _cache = null;

// Lazy load + cache. We re-read env vars on every encrypt/decrypt is too
// chatty; instead we cache and let the rotation script SIGKILL/restart the
// function for fresh values, or call refreshKeys() explicitly.
function loadKeys() {
  if (_cache) return _cache;
  const currentB64 = process.env[ENV_KEY_CURRENT];
  if (!currentB64) {
    throw new Error(`CONFIG_MISSING_${ENV_KEY_CURRENT}`);
  }
  const current = decodeKey(currentB64, ENV_KEY_CURRENT);
  const previous = process.env[ENV_KEY_PREVIOUS]
    ? decodeKey(process.env[ENV_KEY_PREVIOUS], ENV_KEY_PREVIOUS)
    : null;
  const blindB64 = process.env[ENV_BLIND_INDEX];
  if (!blindB64) {
    throw new Error(`CONFIG_MISSING_${ENV_BLIND_INDEX}`);
  }
  const blindMaster = decodeKey(blindB64, ENV_BLIND_INDEX);
  _cache = {
    current: { bytes: current, id: keyId(current) },
    previous: previous ? { bytes: previous, id: keyId(previous) } : null,
    blindMaster,
    blindSubkeys: new Map()
  };
  return _cache;
}

function refreshKeys() {
  _cache = null;
}

function decodeKey(b64, varName) {
  let raw;
  try {
    raw = Buffer.from(b64, 'base64');
  } catch (err) {
    throw new Error(`CONFIG_BAD_${varName}_NOT_BASE64`);
  }
  if (raw.length !== KEY_LENGTH) {
    throw new Error(`CONFIG_BAD_${varName}_LENGTH_${raw.length}_EXPECTED_${KEY_LENGTH}`);
  }
  return raw;
}

function keyId(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

// Returns true if the value looks like one of our wrapped ciphertexts.
// Legacy plaintext values (anything else) flow through encryptField unchanged
// during the migration window.
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(CIPHER_PREFIX);
}

function encryptField(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  if (typeof plaintext !== 'string') plaintext = String(plaintext);
  const keys = loadKeys();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.current.bytes, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'enc',
    'v1',
    'a256gcm',
    keys.current.id,
    iv.toString('base64'),
    ct.toString('base64'),
    tag.toString('base64')
  ].join(':');
}

function decryptField(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') return String(value);
  if (!isEncrypted(value)) {
    // Legacy plaintext row -- pass through untouched. Migration script will
    // re-write all such rows in encrypted form.
    return value;
  }
  const parts = value.split(':');
  // [0]='enc' [1]='v1' [2]='a256gcm' [3]=keyId8 [4]=iv [5]=ct [6]=tag
  if (parts.length !== 7) {
    throw new Error('CRYPTO_BAD_CIPHERTEXT_FORMAT');
  }
  const [, version, alg, ctKeyId, ivB64, ctB64, tagB64] = parts;
  if (version !== 'v1' || alg !== 'a256gcm') {
    throw new Error(`CRYPTO_UNSUPPORTED_ENVELOPE_${version}_${alg}`);
  }
  const keys = loadKeys();
  let keyBytes = null;
  if (keys.current.id === ctKeyId) keyBytes = keys.current.bytes;
  else if (keys.previous && keys.previous.id === ctKeyId) keyBytes = keys.previous.bytes;
  if (!keyBytes) {
    throw new Error(`CRYPTO_NO_KEY_FOR_ID_${ctKeyId}`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_LENGTH) throw new Error('CRYPTO_BAD_IV_LENGTH');
  if (tag.length !== TAG_LENGTH) throw new Error('CRYPTO_BAD_TAG_LENGTH');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    throw new Error(`CRYPTO_DECRYPT_FAILED_${ctKeyId}`);
  }
}

// HKDF-SHA256 per-field subkey derivation, so a leak of the blind index
// master never lets an attacker cross-correlate first/last/phone hashes via
// the same HMAC key. We cache the derived subkey per field.
function getBlindSubkey(fieldName) {
  const keys = loadKeys();
  let sk = keys.blindSubkeys.get(fieldName);
  if (sk) return sk;
  sk = Buffer.from(crypto.hkdfSync(
    'sha256',
    keys.blindMaster,
    Buffer.alloc(0),                       // empty salt; master is already random
    Buffer.from(`rsvp-blind-index:${fieldName}`, 'utf8'),
    32
  ));
  keys.blindSubkeys.set(fieldName, sk);
  return sk;
}

function blindIndex(normalizedValue, fieldName) {
  if (normalizedValue == null || normalizedValue === '') return '';
  if (!fieldName) throw new Error('CRYPTO_BLIND_INDEX_REQUIRES_FIELD_NAME');
  const sk = getBlindSubkey(fieldName);
  return crypto.createHmac('sha256', sk).update(String(normalizedValue), 'utf8').digest('hex');
}

// Test helper: generate a fresh 32-byte AES key, base64-encoded, suitable
// for use as RSVP_FIELD_KEY_CURRENT / RSVP_FIELD_KEY_PREVIOUS / RSVP_BLIND_INDEX_KEY.
function generateKeyB64() {
  return crypto.randomBytes(KEY_LENGTH).toString('base64');
}

module.exports = {
  encryptField,
  decryptField,
  isEncrypted,
  blindIndex,
  refreshKeys,
  generateKeyB64,
  // Exposed for tests + scripts that need to introspect the active key id.
  _internals: { loadKeys, keyId, CIPHER_PREFIX }
};
