'use strict';
// Spot test for the new rsvp_lookup endpoint shapes.
// Mocks storage + auth + ratelimit so we can exercise every branch without
// hitting Azure.  Run: node scripts/test-rsvp-lookup.cjs

const Module = require('module');

// Shared mutable state for the storage mock.
const mock = {
  byLastName: new Map(),    // norm => invite[]
  byPhoneNorm: new Map(),   // phoneNorm => invite[]
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

// Swap require() for the three modules the endpoint depends on.
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
const stubs = {
  '../_lib/cors': {
    preflight: () => ({ handled: false, cors: { 'Access-Control-Allow-Origin': '*' }, origin: 'https://example.com' }),
    isAllowedOrigin: () => true,
  },
  '../_lib/ratelimit': {
    clientIp: () => '127.0.0.1',
    hashIp: () => 'abc',
    check: () => ({ ok: true, retryAfter: 0 }),
  },
  '../_lib/auth': {
    issueSessionCookie: (id) => `wedrsvp=cookie-for-${id}; Path=/; HttpOnly`,
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

function fakeInvite(id, firstName, lastName, phone) {
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

(async () => {
  // Scenario A: unique last name → success
  indexInvites([fakeInvite('i_lien', 'John', 'Lien', '5551112222')]);
  let r = await call({ lastName: 'Lien' });
  assert('A.1 unique lastname returns invite', r.status === 200 && r.body.found === true && r.body.invite.inviteId === 'i_lien');
  assert('A.2 sets cookie', typeof r.headers['Set-Cookie'] === 'string' && r.headers['Set-Cookie'].includes('i_lien'));
  assert('A.3 public shape hides phoneNorm', !('phoneNorm' in r.body.invite) && !('phone' in r.body.invite));

  // Scenario B: not found
  r = await call({ lastName: 'Smyth' });
  assert('B.1 not_found returns found:false (no ambiguous)', r.status === 200 && r.body.found === false && !r.body.ambiguous && !r.body.requiresPhoneLast4);

  // Scenario C: ambiguous, both have phones → requiresPhoneLast4
  indexInvites([
    fakeInvite('i_g1', 'Maria', 'Guajan', '5552221111'),
    fakeInvite('i_g2', 'Jose', 'Guajan', '5553334444'),
  ]);
  r = await call({ lastName: 'Guajan' });
  assert('C.1 ambiguous with 2+ phones → requiresPhoneLast4', r.status === 200 && r.body.found === false && r.body.ambiguous === true && r.body.requiresPhoneLast4 === true);

  // Scenario D: ambiguous + correct phone-4 (Maria's 5552221111 → last 4 = 1111)
  r = await call({ lastName: 'Guajan', phoneLast4: '1111' });
  assert('D.1 phone-4 narrows to Maria', r.status === 200 && r.body.found === true && r.body.invite.inviteId === 'i_g1');

  // Scenario E: ambiguous + correct phone-4 for Jose (4444)
  r = await call({ lastName: 'Guajan', phoneLast4: '4444' });
  assert('E.1 phone-4 narrows to Jose', r.status === 200 && r.body.found === true && r.body.invite.inviteId === 'i_g2');

  // Scenario F: ambiguous + wrong phone-4 → still requiresPhoneLast4 (re-prompt)
  r = await call({ lastName: 'Guajan', phoneLast4: '9999' });
  assert('F.1 wrong phone-4 returns requiresPhoneLast4 again', r.status === 200 && r.body.found === false && r.body.ambiguous === true && r.body.requiresPhoneLast4 === true);

  // Scenario G: ambiguous + bad phone-4 length → re-prompt
  r = await call({ lastName: 'Guajan', phoneLast4: '12' });
  assert('G.1 short phone-4 returns requiresPhoneLast4', r.status === 200 && r.body.ambiguous === true && r.body.requiresPhoneLast4 === true);

  // Scenario H: ambiguous AND same phone-4 (both end 1234)
  indexInvites([
    fakeInvite('i_x1', 'A', 'Same', '5551111234'),
    fakeInvite('i_x2', 'B', 'Same', '5552221234'),
  ]);
  r = await call({ lastName: 'Same', phoneLast4: '1234' });
  assert('H.1 multi-match on phone-4 → plain ambiguous (contact-us)', r.status === 200 && r.body.ambiguous === true && !r.body.requiresPhoneLast4);

  // Scenario I: ambiguous but neither has a phone → plain ambiguous
  indexInvites([
    fakeInvite('i_n1', 'A', 'Nophone', ''),
    fakeInvite('i_n2', 'B', 'Nophone', ''),
  ]);
  r = await call({ lastName: 'Nophone' });
  assert('I.1 ambiguous no-phones → plain ambiguous', r.status === 200 && r.body.ambiguous === true && !r.body.requiresPhoneLast4);

  // Scenario J: phone-only lookup, unique → success
  indexInvites([fakeInvite('i_p1', 'Pat', 'Phoner', '5559876543')]);
  r = await call({ phone: '(555) 987-6543' });
  assert('J.1 phone lookup unique → success', r.status === 200 && r.body.found === true && r.body.invite.inviteId === 'i_p1');

  // Scenario K: phone-only, not found
  r = await call({ phone: '5550000000' });
  assert('K.1 phone not found', r.status === 200 && r.body.found === false && !r.body.ambiguous);

  // Scenario L: phone-only ambiguous (shared landline)
  indexInvites([
    fakeInvite('i_s1', 'A', 'House1', '5555555555'),
    fakeInvite('i_s2', 'B', 'House2', '5555555555'),
  ]);
  r = await call({ phone: '555-555-5555' });
  assert('L.1 shared phone → ambiguous', r.status === 200 && r.body.found === false && r.body.ambiguous === true);

  // Scenario M: invalid phone format
  r = await call({ phone: '123' });
  assert('M.1 invalid phone → 400 invalid_phone', r.status === 400 && r.body.error === 'invalid_phone');

  // Scenario N: missing input
  r = await call({});
  assert('N.1 empty body → 400 missing_lookup_input', r.status === 400 && r.body.error === 'missing_lookup_input');

  // Scenario O: too-short last name
  r = await call({ lastName: 'X' });
  assert('O.1 single-char lastname → 400 name_too_short', r.status === 400 && r.body.error === 'name_too_short');

  // Scenario P: legacy {firstName, lastName} → uses lastName only
  indexInvites([fakeInvite('i_legacy', 'OldFirst', 'Legacy', '5550001111')]);
  r = await call({ firstName: 'IgnoredOldClient', lastName: 'Legacy' });
  assert('P.1 legacy firstName ignored, lookup by lastName succeeds', r.status === 200 && r.body.found === true && r.body.invite.inviteId === 'i_legacy');

  // Scenario Q: precedence — both phone and lastName present, phone wins
  indexInvites([
    fakeInvite('i_phone_target', 'Phone', 'Match', '5557778888'),
    fakeInvite('i_name_other',  'Other', 'Lookup', '5551231234'),
  ]);
  r = await call({ lastName: 'Lookup', phone: '5557778888' });
  assert('Q.1 phone wins precedence over lastName', r.status === 200 && r.body.found === true && r.body.invite.inviteId === 'i_phone_target');

  // Scenario R: case + accent normalization
  indexInvites([fakeInvite('i_acc', 'José', 'Núñez', '5551234567')]);
  r = await call({ lastName: 'NUNEZ' });
  assert('R.1 case+accent insensitive lastName lookup', r.status === 200 && r.body.found === true && r.body.invite.inviteId === 'i_acc');

  // Scenario S: invalid JSON body
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
  assert('S.1 non-JSON body → 400 invalid_json', captured.status === 400 && captured.body.error === 'invalid_json');

  // Scenario T: unique last-name match BUT user submitted phone-4 (shouldn't reach in normal client flow,
  // but legacy bug-prevention).  If the lone match's phone ends with the digits → success; else re-prompt.
  indexInvites([fakeInvite('i_only', 'Sole', 'Loner', '5559991111')]);
  r = await call({ lastName: 'Loner', phoneLast4: '1111' });
  assert('T.1 unique + matching phone-4 still returns success', r.status === 200 && r.body.found === true);
  r = await call({ lastName: 'Loner', phoneLast4: '9999' });
  assert('T.2 unique + mismatching phone-4 returns requiresPhoneLast4', r.status === 200 && r.body.found === false && r.body.requiresPhoneLast4 === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
