'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const ratelimit = require('../_lib/ratelimit');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const { emptyPayload } = require('../_lib/payload');

const RATE_LIMIT_PER_MIN = 5;
const RATE_WINDOW_MS = 60_000;
const MIN_NAME_CHARS = 2;
const MAX_NAME_CHARS = 80;
const MAX_BODY_BYTES = 4 * 1024;

function sanitizeName(s) {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, MAX_NAME_CHARS);
}

// Public shape — never expose phone, adminNotes, opted-out, hardFail, etc.
function publicInvite(inv) {
  return {
    inviteId: inv.inviteId,
    primaryFirstName: inv.primaryFirstName,
    primaryLastName: inv.primaryLastName,
    locale: inv.locale,
    hasPhone: !!inv.phoneNorm,
    payload: inv.payload || emptyPayload(),
    responded: !!inv.responded,
    respondedAt: inv.respondedAt || ''
  };
}

module.exports = async function (context, req) {
  const pre = preflight(req, 'POST, OPTIONS');
  if (pre.handled) { context.res = pre.response; return; }
  const { cors, origin } = pre;

  if (req.method !== 'POST') {
    context.res = { status: 405, headers: cors, body: { error: 'Method not allowed' } };
    return;
  }
  if (!isAllowedOrigin(origin)) {
    context.res = { status: 403, headers: cors, body: { error: 'Origin not allowed' } };
    return;
  }
  const contentType = ((req.headers && (req.headers['content-type'] || req.headers['Content-Type'])) || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    context.res = { status: 415, headers: cors, body: { error: 'Content-Type must be application/json' } };
    return;
  }
  if (req.rawBody && typeof req.rawBody === 'string' && req.rawBody.length > MAX_BODY_BYTES) {
    context.res = { status: 413, headers: cors, body: { error: 'Payload too large' } };
    return;
  }

  const ip = ratelimit.clientIp(req);
  const ipHash = ratelimit.hashIp(ip);
  const rl = ratelimit.check('rsvp_lookup', ip, RATE_LIMIT_PER_MIN, RATE_WINDOW_MS);
  if (!rl.ok) {
    context.log(`rsvp_lookup 429 ipHash=${ipHash}`);
    context.res = {
      status: 429,
      headers: { ...cors, 'Retry-After': String(rl.retryAfter) },
      body: { error: 'rate_limited', retryAfter: rl.retryAfter }
    };
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { body = null; }
  if (!body || typeof body !== 'object') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_json' } };
    return;
  }

  // The endpoint supports three request shapes:
  //   A) { lastName }                          — primary lookup by last name only.
  //   B) { lastName, phoneLast4 }              — disambiguation after an A response with requiresPhoneLast4.
  //   C) { phone }                             — fallback "look me up by phone" when the name lookup failed.
  //   D) { firstName, lastName }               — legacy shape (older deployed JS). firstName is ignored.
  //
  // Phone mode (C) wins precedence — if `phone` is present, we ignore name fields entirely so a stale
  // client tab can't accidentally double-submit both shapes.
  const rawLastName = sanitizeName(body.lastName);
  const rawPhone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 32) : '';
  const rawPhoneLast4 = typeof body.phoneLast4 === 'string'
    ? body.phoneLast4.replace(/\D/g, '').slice(0, 4)
    : '';

  let invite;
  let lookupMode;
  try {
    if (rawPhone) {
      lookupMode = 'phone';
      invite = await lookupByPhone(rawPhone, context, ipHash, cors);
    } else if (rawLastName) {
      lookupMode = rawPhoneLast4 ? 'lastName+phone4' : 'lastName';
      invite = await lookupByLastName(rawLastName, rawPhoneLast4, context, ipHash, cors);
    } else {
      context.res = { status: 400, headers: cors, body: { error: 'missing_lookup_input' } };
      return;
    }
  } catch (err) {
    if (err && err.responseBody) {
      // The helper already prepared a response shape (e.g., found:false, ambiguous, etc.).
      context.res = err.responseBody;
      return;
    }
    context.log.error(`rsvp_lookup storage err mode=${lookupMode}: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  if (!invite) {
    // Defensive — should have been handled by the helper, but guard anyway.
    context.res = { status: 200, headers: { ...cors, 'Cache-Control': 'no-store' }, body: { found: false } };
    return;
  }

  let cookie;
  try {
    cookie = auth.issueSessionCookie(invite.inviteId);
  } catch (err) {
    context.log.error(`rsvp_lookup cookie err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }

  context.log(`rsvp_lookup hit mode=${lookupMode} ipHash=${ipHash} inviteId=${invite.inviteId}`);
  context.res = {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': cookie
    },
    body: {
      found: true,
      invite: publicInvite(invite)
    }
  };
};

// Helper that throws { responseBody } to signal a non-200-but-handled outcome
// (e.g., found:false, ambiguous, requiresPhoneLast4) so the main handler can
// emit the right response without inflating the happy-path code.
function shortCircuit(status, headers, body) {
  const err = new Error('SHORT_CIRCUIT');
  err.responseBody = { status, headers, body };
  return err;
}

async function lookupByLastName(lastName, phoneLast4, context, ipHash, cors) {
  if (storage.normalizeName(lastName).length < MIN_NAME_CHARS) {
    throw shortCircuit(400, cors, { error: 'name_too_short' });
  }

  const matches = await storage.findInvitesByLastName(lastName);

  if (matches.length === 0) {
    context.log(`rsvp_lookup miss mode=lastName ipHash=${ipHash}`);
    throw shortCircuit(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      { found: false });
  }

  if (matches.length === 1 && !phoneLast4) {
    return matches[0];
  }

  // Multiple invites share this last name. Try to narrow with phone last 4.
  const matchesWithPhone = matches.filter(m => m.phoneNorm);

  if (phoneLast4) {
    if (phoneLast4.length !== 4) {
      // Caller sent a partial; ask again.
      context.log(`rsvp_lookup phone4 bad-length mode=lastName+phone4 ipHash=${ipHash}`);
      throw shortCircuit(200, { ...cors, 'Cache-Control': 'no-store' },
        { found: false, ambiguous: true, requiresPhoneLast4: true });
    }
    const refined = matches.filter(m => m.phoneNorm && m.phoneNorm.endsWith(phoneLast4));
    if (refined.length === 1) return refined[0];
    if (refined.length > 1) {
      // Same last name AND same last-4 — extremely rare. Bail to contact-us.
      context.log(`rsvp_lookup phone4 still-ambiguous mode=lastName+phone4 ipHash=${ipHash} n=${refined.length}`);
      throw shortCircuit(200, { ...cors, 'Cache-Control': 'no-store' },
        { found: false, ambiguous: true });
    }
    // refined.length === 0 → phone didn't match any of the surname matches.
    // Keep them in the disambig flow so the UI can say "that phone doesn't match — try again".
    context.log(`rsvp_lookup phone4 no-match mode=lastName+phone4 ipHash=${ipHash}`);
    throw shortCircuit(200, { ...cors, 'Cache-Control': 'no-store' },
      { found: false, ambiguous: true, requiresPhoneLast4: true });
  }

  // No phoneLast4 supplied: tell the client to ask for it, but only if at least
  // 2 of the matches actually have a phone on file (else disambig is impossible).
  if (matchesWithPhone.length >= 2) {
    context.log(`rsvp_lookup ambiguous-needs-phone4 mode=lastName ipHash=${ipHash} matchCount=${matches.length}`);
    throw shortCircuit(200, { ...cors, 'Cache-Control': 'no-store' },
      { found: false, ambiguous: true, requiresPhoneLast4: true });
  }

  // Multiple matches but we can't disambiguate via phone — give up cleanly.
  context.log(`rsvp_lookup ambiguous-no-phone mode=lastName ipHash=${ipHash} matchCount=${matches.length}`);
  throw shortCircuit(200, { ...cors, 'Cache-Control': 'no-store' },
    { found: false, ambiguous: true });
}

async function lookupByPhone(rawPhone, context, ipHash, cors) {
  const phoneNorm = storage.normalizePhone(rawPhone);
  if (!phoneNorm) {
    throw shortCircuit(400, cors, { error: 'invalid_phone' });
  }

  const matches = await storage.findInvitesByPhoneNorm(phoneNorm);

  if (matches.length === 0) {
    context.log(`rsvp_lookup miss mode=phone ipHash=${ipHash}`);
    throw shortCircuit(200, { ...cors, 'Cache-Control': 'no-store' },
      { found: false });
  }

  if (matches.length > 1) {
    // Households sharing one number. We can't pick a household for them.
    context.log(`rsvp_lookup ambiguous mode=phone ipHash=${ipHash} matchCount=${matches.length}`);
    throw shortCircuit(200, { ...cors, 'Cache-Control': 'no-store' },
      { found: false, ambiguous: true });
  }

  return matches[0];
}
