'use strict';

// Round-trip + rotation test harness for api/_lib/fieldcrypto.js.
//
// Doesn't talk to Azure -- exercises every code path locally so we can prove
// the crypto behaves correctly before pushing rows of ciphertext into Table
// Storage and learning the hard way.
//
//   node scripts/test-field-encryption.cjs

const path = require('path');
const assert = require('assert');

const crypto = require('crypto');

const FC_PATH = path.resolve(__dirname, '..', 'api', '_lib', 'fieldcrypto.js');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    fail++;
  }
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] == null) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  // Force re-load of the crypto module + key cache so env changes take effect.
  delete require.cache[FC_PATH];
  const fc = require(FC_PATH);
  try {
    return fn(fc);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');
const BLIND_KEY = crypto.randomBytes(32).toString('base64');

console.log('test-field-encryption.cjs');
console.log('-------------------------');

test('roundtrip: encrypt then decrypt returns original plaintext', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_FIELD_KEY_PREVIOUS: null, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    for (const pt of ['John', 'Diana', '+15551234567', 'Médina', '', 'with spaces & punct!']) {
      const ct = fc.encryptField(pt);
      const back = fc.decryptField(ct);
      assert.strictEqual(back, pt, `mismatch for "${pt}"`);
    }
  });
});

test('encrypt emits well-formed envelope with our prefix', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    const ct = fc.encryptField('John');
    assert.ok(ct.startsWith('enc:v1:a256gcm:'), `bad prefix: ${ct}`);
    const parts = ct.split(':');
    assert.strictEqual(parts.length, 7);
    assert.strictEqual(parts[3].length, 8, 'keyId8 should be 8 hex chars');
    assert.ok(fc.isEncrypted(ct));
    assert.ok(!fc.isEncrypted('John'));
  });
});

test('empty string round-trips to empty (not encrypted)', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    assert.strictEqual(fc.encryptField(''), '');
    assert.strictEqual(fc.encryptField(null), '');
    assert.strictEqual(fc.decryptField(''), '');
    assert.strictEqual(fc.decryptField(null), '');
  });
});

test('decrypt passes through legacy plaintext untouched', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    assert.strictEqual(fc.decryptField('John'), 'John');
    assert.strictEqual(fc.decryptField('+15551234567'), '+15551234567');
  });
});

test('rotation: PREVIOUS key still decrypts old data after CURRENT swap', () => {
  // Step 1: encrypt under key A as the only key.
  let ctOldA;
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_FIELD_KEY_PREVIOUS: null, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    ctOldA = fc.encryptField('John');
  });
  // Step 2: rotate -- new CURRENT is key B, PREVIOUS is key A.
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_B, RSVP_FIELD_KEY_PREVIOUS: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    assert.strictEqual(fc.decryptField(ctOldA), 'John', 'PREVIOUS should decrypt old ciphertext');
    // New writes go out under CURRENT (key B), with a different keyId8.
    const ctNew = fc.encryptField('Diana');
    const idOld = ctOldA.split(':')[3];
    const idNew = ctNew.split(':')[3];
    assert.notStrictEqual(idOld, idNew, 'rotated key should produce different keyId8');
    assert.strictEqual(fc.decryptField(ctNew), 'Diana');
    // And the old row is still readable through PREVIOUS in the same call.
    assert.strictEqual(fc.decryptField(ctOldA), 'John');
  });
});

test('rotation cleanup: once PREVIOUS is cleared, old-key ciphertext fails decryption', () => {
  let ctOldA;
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    ctOldA = fc.encryptField('John');
  });
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_B, RSVP_FIELD_KEY_PREVIOUS: null, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    assert.throws(() => fc.decryptField(ctOldA), /CRYPTO_NO_KEY_FOR_ID_/);
  });
});

test('blindIndex: deterministic for same field+input, different across fields', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    const a1 = fc.blindIndex('john', 'firstName');
    const a2 = fc.blindIndex('john', 'firstName');
    assert.strictEqual(a1, a2);
    assert.strictEqual(a1.length, 64, 'SHA256 hex is 64 chars');

    const b = fc.blindIndex('john', 'lastName');
    assert.notStrictEqual(a1, b, 'same input on different field should differ (HKDF per-field subkey)');

    const empty = fc.blindIndex('', 'firstName');
    assert.strictEqual(empty, '');
  });
});

test('blindIndex: identical input + identical key across calls is stable (lookup queries depend on it)', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    const a = fc.blindIndex('+15551234567', 'phone');
    delete require.cache[FC_PATH];
    const fc2 = require(FC_PATH);
    const b = fc2.blindIndex('+15551234567', 'phone');
    assert.strictEqual(a, b, 'blind index must be stable across processes');
  });
});

test('decrypt rejects ciphertext that was tampered with (GCM auth tag check)', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    const ct = fc.encryptField('John');
    const parts = ct.split(':');
    // flip a bit in the ciphertext portion (parts[5])
    const ctBytes = Buffer.from(parts[5], 'base64');
    ctBytes[0] ^= 0x01;
    parts[5] = ctBytes.toString('base64');
    const tampered = parts.join(':');
    assert.throws(() => fc.decryptField(tampered), /CRYPTO_DECRYPT_FAILED/);
  });
});

test('missing CURRENT env var raises CONFIG_MISSING', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: null, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    assert.throws(() => fc.encryptField('John'), /CONFIG_MISSING_RSVP_FIELD_KEY_CURRENT/);
  });
});

test('badly-sized key raises CONFIG_BAD_*', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: Buffer.from('too-short').toString('base64'), RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    assert.throws(() => fc.encryptField('John'), /CONFIG_BAD_RSVP_FIELD_KEY_CURRENT_LENGTH/);
  });
});

test('generateKeyB64 produces a 32-byte base64 key suitable for re-import', () => {
  withEnv({ RSVP_FIELD_KEY_CURRENT: KEY_A, RSVP_BLIND_INDEX_KEY: BLIND_KEY }, (fc) => {
    const k = fc.generateKeyB64();
    const raw = Buffer.from(k, 'base64');
    assert.strictEqual(raw.length, 32);
  });
});

console.log('-------------------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
