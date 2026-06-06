'use strict';
// Spot test for the rsvp_lookup endpoint shapes.
// Mocks storage + auth + ratelimit so we can exercise every branch without
// hitting Azure. Covers both the legacy direct-session path (phoneless /
// opted-out / hard-failed invites) AND the new step-up auth path
// (phone-eligible invites → rsvp_ticket cookie + requiresVerification).
// Run: node scripts/test-rsvp-lookup.cjs

const Module = require('module');

const mock = {
  byLastName: new Map(),
  byPhoneNorm: new Map(),
};

function normalizeName(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}
function normalizePhone(p) {
  if (typeof p !== 'string') return '';
  const cleaned = p.split(/(?:ext\.?|extension|x(?=\s|\d)|,|;)/i)[0];
  const digits = cleaned.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

const origLoad = Module._load;
// Mutable per-bucket allow/deny map so individual tests can simulate the
// per-last-name throttle returning 429 without rewiring everything.
const rlOverrides = new Map();
const stubs = {
  '../_lib/cors': {
    preflight: () => ({ handled: false, cors: { 'Access-Control-Allow-Origin': '*' }, origin: 'https://example.com' }),
    isAllowedOrigin: () => true,
  },
  '../_lib/ratelimit': {
    clientIp: () => '127.0.0.1',
    hashIp: () => 'abc',
    check: (bucket, key) => {
      const override = rlOverrides.get(`${bucket}:${key}`);
      if (override) return override;
      return { ok: true, retryAfter: 0 };
    },
  },
  '../_lib/auth': {
    issueSessionCookie: (id) => `rsvp_session=session-for-${id}; Path=/; HttpOnly`,
    issueLookupTicketCookie: (id) => `rsvp_ticket=ticket-for-${id}; Path=/api/rsvp; HttpOnly`,
    clearLookupTicketCookie: () => `rsvp_ticket=; Path=/api/rsvp; HttpOnly; Max-Age=0`,
  },
  '../_lib/storage': {
    normalizeName,
    normalizePhone,
    findInvitesByLastName: async (lastName) => mock.byLastName.get(normalizeName(lastName)) || [],
    findInvitesByPhoneNorm: async (phoneNorm) => mock.byPhoneNorm.get(phoneNorm) || [],
  },
  '../_lib/payload': { emptyPayload: () => ({ primary: {}, additionalGuests: [] }) },
};
Module._load = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, parent, ...rest);
};

const handler = require('../api/rsvp_lookup/index.js');

async function call(body) {
  let captured;
  const ctx = {
    log: Object.assign(() => {}, { error: () => {} }),
    get res() { return captured; },
    set res(v) { captured = v; }
  };
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', origin: 'https://example.com' },
    body,
    rawBody: JSON.stringify(body || {}),
  };
  await handler(ctx, req);
  return captured;
}

function fakeInvite(id, firstName, lastName, phone, opts) {
  const phoneNorm = normalizePhone(phone || '');
  return {
    inviteId: id,
    primaryFirstName: firstName,
    primaryLastName: lastName,
    primaryFirstNorm: normalizeName(firstName),
    primaryLastNorm: normalizeName(lastName),
    phone: phone || '',
    phoneNorm,
    locale: 'en',
    payload: null,
    responded: false,
    respondedAt: '',
    respondedLate: false,
    optedOutOfSms: !!(opts && opts.optedOut),
    smsHardFailedAt: (opts && opts.hardFailed) ? '2026-01-01T00:00:00Z' : '',
  };
}

function indexInvites(invites) {
  mock.byLastName.clear();
  mock.byPhoneNorm.clear();
  for (const inv of invites) {
    const ln = inv.primaryLastNorm;
    if (!mock.byLastName.has(ln)) mock.byLastName.set(ln, []);
    mock.byLastName.get(ln).push(inv);
    if (inv.phoneNorm) {
      if (!mock.byPhoneNorm.has(inv.phoneNorm)) mock.byPhoneNorm.set(inv.phoneNorm, []);
      mock.byPhoneNorm.get(inv.phoneNorm).push(inv);
    }
  }
}

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
}

function cookieStr(r) {
  const sc = r && r.headers && r.headers['Set-Cookie'];
  if (!sc) return '';
  return Array.isArray(sc) ? sc.join(' || ') : String(sc);
}

// Assert phone-eligible invite → step-up auth: rsvp_ticket cookie + thin payload.
function assertStepUp(name, r, inviteId, last4) {
  assert(`${name}.status200`, r.status === 200);
  assert(`${name}.found`, r.body && r.body.found === true);
  assert(`${name}.requiresVerification=true`, r.body.requiresVerification === true);
  assert(`${name}.ticketCookieForInvite`, cookieStr(r).includes(`ticket-for-${inviteId}`));
  assert(`${name}.noSessionCookie`, !cookieStr(r).includes(`session-for-${inviteId}`));
  assert(`${name}.payloadHasFirstNameOnly`,
    r.body.invite && !!r.body.invite.firstName && !r.body.invite.inviteId && !r.body.invite.primaryLastName && !r.body.invite.payload);
  assert(`${name}.phoneLast4=${last4}`, r.body.invite.phoneLast4 === last4);
}

// Assert phoneless / opted-out / hard-failed invite → direct session + full publicInvite payload.
function assertDirect(name, r, inviteId) {
  assert(`${name}.status200`, r.status === 200);
  assert(`${name}.found`, r.body && r.body.found === true);
  assert(`${name}.requiresVerification=false`, r.body.requiresVerification === false);
  assert(`${name}.sessionCookieForInvite`, cookieStr(r).includes(`session-for-${inviteId}`));
  assert(`${name}.noTicketCookie`, !cookieStr(r).includes(`ticket-for-${inviteId}`));
  assert(`${name}.fullPublicInvite`,
    r.body.invite && r.body.invite.inviteId === inviteId && 'payload' in r.body.invite && 'hasPhone' in r.body.invite);
  assert(`${name}.publicInviteHidesPhone`, !('phoneNorm' in r.body.invite) && !('phone' in r.body.invite));
}

(async () => {
  // ============================================================
  // STEP-UP PATH (invite has usable phone): rsvp_ticket cookie,
  // thin payload, requiresVerification: true
  // ============================================================

  // A: unique lastname, phone on file → step-up
  indexInvites([fakeInvite('i_lien', 'John', 'Lien', '5551112222')]);
  let r = await call({ lastName: 'Lien' });
  assertStepUp('A unique-lastname-with-phone', r, 'i_lien', '2222');

  // D/E: ambiguous → phone-4 resolves to one, that one has phone → step-up
  indexInvites([
    fakeInvite('i_g1', 'Maria', 'Guajan', '5552221111'),
    fakeInvite('i_g2', 'Jose', 'Guajan', '5553334444'),
  ]);
  r = await call({ lastName: 'Guajan', phoneLast4: '1111' });
  assertStepUp('D phone4-resolves-Maria', r, 'i_g1', '1111');
  r = await call({ lastName: 'Guajan', phoneLast4: '4444' });
  assertStepUp('E phone4-resolves-Jose', r, 'i_g2', '4444');

  // J: phone lookup unique → step-up
  indexInvites([fakeInvite('i_p1', 'Pat', 'Phoner', '5559876543')]);
  r = await call({ phone: '(555) 987-6543' });
  assertStepUp('J phone-lookup-unique', r, 'i_p1', '6543');

  // P: legacy {firstName, lastName} → uses lastName only, has phone → step-up
  indexInvites([fakeInvite('i_legacy', 'OldFirst', 'Legacy', '5550001111')]);
  r = await call({ firstName: 'IgnoredOldClient', lastName: 'Legacy' });
  assertStepUp('P legacy-firstName-ignored', r, 'i_legacy', '1111');

  // Q: phone wins precedence over lastName
  indexInvites([
    fakeInvite('i_phone_target', 'Phone', 'Match', '5557778888'),
    fakeInvite('i_name_other',  'Other', 'Lookup', '5551231234'),
  ]);
  r = await call({ lastName: 'Lookup', phone: '5557778888' });
  assertStepUp('Q phone-wins-precedence', r, 'i_phone_target', '8888');

  // R: case + accent normalization, has phone → step-up
  indexInvites([fakeInvite('i_acc', 'José', 'Núñez', '5551234567')]);
  r = await call({ lastName: 'NUNEZ' });
  assertStepUp('R case-accent-insensitive', r, 'i_acc', '4567');

  // T: unique + matching phone-4, has phone → step-up
  indexInvites([fakeInvite('i_only', 'Sole', 'Loner', '5559991111')]);
  r = await call({ lastName: 'Loner', phoneLast4: '1111' });
  assertStepUp('T unique-matching-phone4', r, 'i_only', '1111');

  // ============================================================
  // DIRECT PATH (no usable phone): session cookie, full publicInvite
  // ============================================================

  // U: unique lastname, no phone on file → direct session
  indexInvites([fakeInvite('i_nophone', 'Phoneless', 'Person', '')]);
  r = await call({ lastName: 'Person' });
  assertDirect('U unique-no-phone', r, 'i_nophone');

  // V: unique lastname, has phone but opted out → direct session
  indexInvites([fakeInvite('i_optout', 'Opted', 'Out', '5556667777', { optedOut: true })]);
  r = await call({ lastName: 'Out' });
  assertDirect('V opted-out-fallback', r, 'i_optout');

  // W: unique lastname, has phone but hard-failed → direct session
  indexInvites([fakeInvite('i_hf', 'Hard', 'Failed', '5558889999', { hardFailed: true })]);
  r = await call({ lastName: 'Failed' });
  assertDirect('W hard-failed-fallback', r, 'i_hf');

  // ============================================================
  // NEGATIVE / AMBIGUOUS / VALIDATION PATHS (no cookie, no body.invite)
  // ============================================================

  // B: not found
  indexInvites([fakeInvite('i_lien', 'John', 'Lien', '5551112222')]);
  r = await call({ lastName: 'Smyth' });
  assert('B not_found',
    r.status === 200 && r.body.found === false && !r.body.ambiguous && !r.body.requiresPhoneLast4);

  // C: ambiguous, both have phones → requiresPhoneLast4
  indexInvites([
    fakeInvite('i_g1', 'Maria', 'Guajan', '5552221111'),
    fakeInvite('i_g2', 'Jose', 'Guajan', '5553334444'),
  ]);
  r = await call({ lastName: 'Guajan' });
  assert('C ambiguous-with-phones-requires-phone4',
    r.status === 200 && r.body.found === false && r.body.ambiguous === true && r.body.requiresPhoneLast4 === true);

  // F: wrong phone-4 → re-prompt
  r = await call({ lastName: 'Guajan', phoneLast4: '9999' });
  assert('F wrong-phone4-reprompt',
    r.status === 200 && r.body.found === false && r.body.ambiguous === true && r.body.requiresPhoneLast4 === true);

  // G: short phone-4 → re-prompt
  r = await call({ lastName: 'Guajan', phoneLast4: '12' });
  assert('G short-phone4-reprompt',
    r.status === 200 && r.body.ambiguous === true && r.body.requiresPhoneLast4 === true);

  // H: ambiguous + same phone-4 → plain ambiguous (contact-us)
  indexInvites([
    fakeInvite('i_x1', 'A', 'Same', '5551111234'),
    fakeInvite('i_x2', 'B', 'Same', '5552221234'),
  ]);
  r = await call({ lastName: 'Same', phoneLast4: '1234' });
  assert('H multi-match-on-phone4-plain-ambiguous',
    r.status === 200 && r.body.ambiguous === true && !r.body.requiresPhoneLast4);

  // I: ambiguous, neither has phone → plain ambiguous
  indexInvites([
    fakeInvite('i_n1', 'A', 'Nophone', ''),
    fakeInvite('i_n2', 'B', 'Nophone', ''),
  ]);
  r = await call({ lastName: 'Nophone' });
  assert('I ambiguous-no-phones-plain-ambiguous',
    r.status === 200 && r.body.ambiguous === true && !r.body.requiresPhoneLast4);

  // K: phone-only, not found
  r = await call({ phone: '5550000000' });
  assert('K phone-not-found',
    r.status === 200 && r.body.found === false && !r.body.ambiguous);

  // L: phone-only ambiguous (shared landline)
  indexInvites([
    fakeInvite('i_s1', 'A', 'House1', '5555555555'),
    fakeInvite('i_s2', 'B', 'House2', '5555555555'),
  ]);
  r = await call({ phone: '555-555-5555' });
  assert('L shared-phone-ambiguous',
    r.status === 200 && r.body.found === false && r.body.ambiguous === true);

  // M: invalid phone format
  r = await call({ phone: '123' });
  assert('M invalid-phone-400',
    r.status === 400 && r.body.error === 'invalid_phone');

  // N: missing input
  r = await call({});
  assert('N empty-body-400-missing-input',
    r.status === 400 && r.body.error === 'missing_lookup_input');

  // O: too-short last name
  r = await call({ lastName: 'X' });
  assert('O single-char-lastname-400-name-too-short',
    r.status === 400 && r.body.error === 'name_too_short');

  // T.2: unique + mismatching phone-4 → requiresPhoneLast4
  indexInvites([fakeInvite('i_only', 'Sole', 'Loner', '5559991111')]);
  r = await call({ lastName: 'Loner', phoneLast4: '9999' });
  assert('T2 unique-mismatching-phone4-requiresPhone4',
    r.status === 200 && r.body.found === false && r.body.requiresPhoneLast4 === true);

  // S: invalid JSON body
  let captured;
  const ctx = {
    log: Object.assign(() => {}, { error: () => {} }),
    get res() { return captured; },
    set res(v) { captured = v; },
  };
  await handler(ctx, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.com', 'x-forwarded-for': '127.0.0.1' },
    body: 'not json',
    rawBody: 'not json',
  });
  assert('S non-JSON-body-400-invalid-json',
    captured.status === 400 && captured.body.error === 'invalid_json');

  // ============================================================
  // PER-LAST-NAME THROTTLE (#5)
  // ============================================================

  // X: per-last-name throttle returns 429 + Retry-After even when the name
  // would otherwise resolve. Note that the IP bucket is checked BEFORE the
  // lastName bucket (in the main handler), so the override here targets the
  // post-IP path triggered inside lookupByLastName.
  indexInvites([fakeInvite('i_throttled', 'Test', 'Throttled', '5559990001')]);
  rlOverrides.set('rsvp_lookup:lastName:throttled', { ok: false, retryAfter: 600 });
  r = await call({ lastName: 'Throttled' });
  assert('X throttled-lastname-429',
    r.status === 429
    && r.body.error === 'rate_limited'
    && r.body.retryAfter === 600
    && r.headers['Retry-After'] === '600');
  rlOverrides.clear();

  // Y: normalization joins variant casings into the same throttle bucket
  // ('THROTTLED' must hit the same key as 'throttled').
  rlOverrides.set('rsvp_lookup:lastName:throttled', { ok: false, retryAfter: 1 });
  r = await call({ lastName: 'THROTTLED' });
  assert('Y throttle-bucket-uses-normalized-name', r.status === 429);
  rlOverrides.clear();

  // Z: throttle does NOT trigger on phone-only lookups (different code path).
  rlOverrides.set('rsvp_lookup:lastName:throttled', { ok: false, retryAfter: 1 });
  indexInvites([fakeInvite('i_p9', 'Phoner', 'Throttled', '5559876543')]);
  r = await call({ phone: '(555) 987-6543' });
  assert('Z phone-lookup-bypasses-lastName-throttle',
    r.status === 200 && r.body.found === true);
  rlOverrides.clear();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
