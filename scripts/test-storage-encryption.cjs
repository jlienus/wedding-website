'use strict';

// Round-trip tests for the storage.js encryption layer.
//
// Validates that:
//   - inviteToEntity emits ciphertext + blind index + cleared *Norm columns
//   - entityToInvite decrypts and reconstructs the same plaintext, plus
//     populates JS-level phoneNorm / primaryFirstNorm / primaryLastNorm
//   - Legacy plaintext rows continue to round-trip through entityToInvite
//   - After key rotation, re-encryption uses the new keyId
//
// Doesn't talk to Azure -- exercises entityToInvite/inviteToEntity directly
// via the _testHooks exposed by storage.js. The TableClient construction in
// getClients() is never invoked.
//
//   node scripts/test-storage-encryption.cjs

const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const KEY_A = crypto.randomBytes(32).toString('base64');
const BLIND_KEY = crypto.randomBytes(32).toString('base64');

process.env.RSVP_FIELD_KEY_CURRENT = KEY_A;
process.env.RSVP_BLIND_INDEX_KEY = BLIND_KEY;

const STORAGE_PATH = path.resolve(__dirname, '..', 'api', '_lib', 'storage.js');
const FC_PATH = path.resolve(__dirname, '..', 'api', '_lib', 'fieldcrypto.js');

function reload() {
  delete require.cache[STORAGE_PATH];
  delete require.cache[FC_PATH];
  return require(STORAGE_PATH);
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (err) { console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n')); fail++; }
}

console.log('test-storage-encryption.cjs');
console.log('---------------------------');

test('inviteToEntity encrypts the 3 PII fields, populates blind indexes, clears legacy norms', () => {
  const storage = reload();
  const { inviteToEntity } = storage._testHooks;
  const e = inviteToEntity({
    inviteId: 'test-001',
    primaryFirstName: 'John',
    primaryLastName: 'Lien',
    phone: '5551234567',
    locale: 'en'
  });
  assert.ok(e.primaryFirstName.startsWith('enc:v1:a256gcm:'), `firstName not encrypted: ${e.primaryFirstName}`);
  assert.ok(e.primaryLastName.startsWith('enc:v1:a256gcm:'));
  assert.ok(e.phone.startsWith('enc:v1:a256gcm:'));
  assert.strictEqual(e.primaryFirstIndex.length, 64);
  assert.strictEqual(e.primaryLastIndex.length, 64);
  assert.strictEqual(e.phoneIndex.length, 64);
  assert.strictEqual(e.primaryFirstNorm, '');
  assert.strictEqual(e.primaryLastNorm, '');
  assert.strictEqual(e.phoneNorm, '');
});

test('round-trip: entityToInvite(inviteToEntity(x)) preserves plaintext + JS-level *Norm fields', () => {
  const storage = reload();
  const { inviteToEntity, entityToInvite } = storage._testHooks;
  const e = inviteToEntity({
    inviteId: 'test-002',
    primaryFirstName: 'Médina',           // accented
    primaryLastName: "O'Brien-Smith",     // apostrophe + hyphen
    phone: '(555) 123-4567 ext 99',       // messy input
    locale: 'es'
  });
  const back = entityToInvite(e);
  assert.strictEqual(back.primaryFirstName, 'Médina');
  assert.strictEqual(back.primaryLastName, "O'Brien-Smith");
  assert.strictEqual(back.phone, '(555) 123-4567 ext 99');
  assert.strictEqual(back.primaryFirstNorm, 'medina');
  assert.strictEqual(back.primaryLastNorm, 'obriensmith');
  assert.strictEqual(back.phoneNorm, '+15551234567'); // extension stripped + E.164'd
  assert.strictEqual(back.locale, 'es');
});

test('legacy plaintext entity decrypts as plaintext (migration window compat)', () => {
  const storage = reload();
  const { entityToInvite } = storage._testHooks;
  const got = entityToInvite({
    partitionKey: 'invites',
    rowKey: 'legacy-001',
    primaryFirstName: 'Diana',
    primaryLastName: 'Rodriguez',
    primaryFirstNorm: 'diana',
    primaryLastNorm: 'rodriguez',
    phone: '6175551212',
    phoneNorm: '+16175551212',
    locale: 'en'
  });
  assert.strictEqual(got.primaryFirstName, 'Diana');
  assert.strictEqual(got.primaryLastName, 'Rodriguez');
  assert.strictEqual(got.phone, '6175551212');
  assert.strictEqual(got.primaryFirstNorm, 'diana');
  assert.strictEqual(got.primaryLastNorm, 'rodriguez');
  assert.strictEqual(got.phoneNorm, '+16175551212');
});

test('empty PII fields stay empty (no spurious encryption of "")', () => {
  const storage = reload();
  const { inviteToEntity, entityToInvite } = storage._testHooks;
  const e = inviteToEntity({ inviteId: 'empty-001', primaryFirstName: '', primaryLastName: '', phone: '' });
  assert.strictEqual(e.primaryFirstName, '');
  assert.strictEqual(e.primaryLastName, '');
  assert.strictEqual(e.phone, '');
  assert.strictEqual(e.primaryFirstIndex, '');
  assert.strictEqual(e.primaryLastIndex, '');
  assert.strictEqual(e.phoneIndex, '');
  const back = entityToInvite(e);
  assert.strictEqual(back.primaryFirstName, '');
  assert.strictEqual(back.phoneNorm, '');
});

test('after key rotation, re-encryption uses the new keyId', () => {
  const storage = reload();
  const { inviteToEntity } = storage._testHooks;
  const first = inviteToEntity({ inviteId: 'rot', primaryFirstName: 'Alice', primaryLastName: 'X', phone: '5550000000' });
  const idA = first.primaryFirstName.split(':')[3];

  // Rotate: A -> PREVIOUS, B -> CURRENT
  const KEY_B = crypto.randomBytes(32).toString('base64');
  process.env.RSVP_FIELD_KEY_PREVIOUS = KEY_A;
  process.env.RSVP_FIELD_KEY_CURRENT = KEY_B;
  const storage2 = reload();
  const { inviteToEntity: ite2, entityToInvite: ent2 } = storage2._testHooks;

  const second = ite2({ inviteId: 'rot', primaryFirstName: 'Alice', primaryLastName: 'X', phone: '5550000000' });
  const idB = second.primaryFirstName.split(':')[3];
  assert.notStrictEqual(idA, idB, 'rotated key should yield different keyId');

  // Old ciphertext is still decryptable because PREVIOUS is loaded
  const decOld = ent2(first);
  assert.strictEqual(decOld.primaryFirstName, 'Alice');

  // Cleanup
  delete process.env.RSVP_FIELD_KEY_PREVIOUS;
  process.env.RSVP_FIELD_KEY_CURRENT = KEY_A;
});

test('after PREVIOUS is cleared, old-key ciphertext throws (proves rotation isolation)', () => {
  const storage = reload();
  const { inviteToEntity, entityToInvite } = storage._testHooks;
  const e = inviteToEntity({ inviteId: 'rot2', primaryFirstName: 'Alice', primaryLastName: 'X', phone: '5550000000' });

  // Swap CURRENT to a new key and DON'T set PREVIOUS.
  const KEY_C = crypto.randomBytes(32).toString('base64');
  process.env.RSVP_FIELD_KEY_CURRENT = KEY_C;
  delete process.env.RSVP_FIELD_KEY_PREVIOUS;
  const storage2 = reload();
  const { entityToInvite: ent2 } = storage2._testHooks;

  assert.throws(() => ent2(e), /CRYPTO_NO_KEY_FOR_ID/);

  // Cleanup
  process.env.RSVP_FIELD_KEY_CURRENT = KEY_A;
});

console.log('---------------------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
