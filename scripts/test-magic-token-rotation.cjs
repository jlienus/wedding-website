'use strict';

// Verifies the dual-secret magic-link rotation path in api/_lib/auth.js
// (finding #1). The contract:
//   - signMagicToken always signs with RSVP_MAGIC_SECRET (the "new" secret).
//   - verifyMagicToken accepts tokens signed with either RSVP_MAGIC_SECRET or
//     RSVP_MAGIC_SECRET_OLD (the "old" secret).
//   - If OLD is missing, too short, or identical to NEW, the fallback is a
//     no-op (no double-acceptance, no spurious verifies).
//   - The TTL'd verify-link format (Format B, 3 parts) is intentionally NOT
//     dual-supported -- it expires in 10 minutes so rotation is free.

const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  return origLoad.call(this, request, parent, ...rest);
};

const NEW_SECRET = 'a'.repeat(48);
const OLD_SECRET = 'b'.repeat(48);
const SHORT_SECRET = 'c'.repeat(16);

function load() {
  // Force re-require so env mutations take effect on every test.
  delete require.cache[require.resolve(path.resolve(__dirname, '..', 'api', '_lib', 'auth.js'))];
  return require(path.resolve(__dirname, '..', 'api', '_lib', 'auth.js'));
}

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}`); }
}

// --- 1: NEW only, no OLD -----------------------------------------------
process.env.RSVP_MAGIC_SECRET = NEW_SECRET;
delete process.env.RSVP_MAGIC_SECRET_OLD;
let auth = load();
let newToken = auth.signMagicToken('inv_1');
assert('1a current-secret-token-verifies', auth.verifyMagicToken(newToken) === 'inv_1');
assert('1b getMagicVerifySecrets-returns-one', auth.getMagicVerifySecrets().length === 1);

// --- 2: Rotation in progress (NEW + OLD both set) ----------------------
// Token issued BEFORE rotation (signed with what is now OLD) must still verify.
process.env.RSVP_MAGIC_SECRET = OLD_SECRET;
delete process.env.RSVP_MAGIC_SECRET_OLD;
auth = load();
const legacyToken = auth.signMagicToken('inv_legacy');

// Operator rotates: NEW becomes the current secret, OLD becomes the fallback.
process.env.RSVP_MAGIC_SECRET = NEW_SECRET;
process.env.RSVP_MAGIC_SECRET_OLD = OLD_SECRET;
auth = load();
assert('2a old-token-still-verifies-during-rotation',
  auth.verifyMagicToken(legacyToken) === 'inv_legacy');

const freshToken = auth.signMagicToken('inv_fresh');
assert('2b new-token-also-verifies-during-rotation',
  auth.verifyMagicToken(freshToken) === 'inv_fresh');

assert('2c getMagicVerifySecrets-returns-two', auth.getMagicVerifySecrets().length === 2);
assert('2d new-secret-comes-first', auth.getMagicVerifySecrets()[0] === NEW_SECRET);

// --- 3: After rotation (OLD removed) -----------------------------------
// The legacy token should now stop verifying. Fresh tokens still work.
delete process.env.RSVP_MAGIC_SECRET_OLD;
auth = load();
assert('3a legacy-token-rejected-after-old-removed', auth.verifyMagicToken(legacyToken) === null);
assert('3b fresh-token-still-verifies', auth.verifyMagicToken(freshToken) === 'inv_fresh');

// --- 4: Defensive: SHORT old secret is ignored -------------------------
process.env.RSVP_MAGIC_SECRET = NEW_SECRET;
process.env.RSVP_MAGIC_SECRET_OLD = SHORT_SECRET;
auth = load();
assert('4a short-old-secret-dropped', auth.getMagicVerifySecrets().length === 1);
assert('4b legacy-token-rejected-when-old-too-short',
  auth.verifyMagicToken(legacyToken) === null);

// --- 5: Defensive: OLD === NEW is ignored (no-op rotation) -------------
process.env.RSVP_MAGIC_SECRET = NEW_SECRET;
process.env.RSVP_MAGIC_SECRET_OLD = NEW_SECRET;
auth = load();
assert('5a identical-secrets-collapse-to-one', auth.getMagicVerifySecrets().length === 1);

// --- 6: Tampered signature on legacy format ----------------------------
process.env.RSVP_MAGIC_SECRET = NEW_SECRET;
process.env.RSVP_MAGIC_SECRET_OLD = OLD_SECRET;
auth = load();
const tampered = auth.signMagicToken('inv_t').replace(/.$/, 'X');
assert('6a tampered-legacy-token-rejected-even-with-old', auth.verifyMagicToken(tampered) === null);

// --- 7: TTL'd Format B is single-secret (not dual) ---------------------
// Sign a TTL'd token with OLD, then rotate to NEW -- it must NOT verify.
process.env.RSVP_MAGIC_SECRET = OLD_SECRET;
delete process.env.RSVP_MAGIC_SECRET_OLD;
auth = load();
const ttlToken = auth.signVerifyMagicToken('inv_ttl');
assert('7a ttl-token-verifies-against-current', auth.verifyMagicToken(ttlToken) === 'inv_ttl');

process.env.RSVP_MAGIC_SECRET = NEW_SECRET;
process.env.RSVP_MAGIC_SECRET_OLD = OLD_SECRET;
auth = load();
assert('7b ttl-token-rejected-after-rotation-even-with-old-set',
  auth.verifyMagicToken(ttlToken) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
