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

  const firstName = sanitizeName(body.firstName);
  const lastName = sanitizeName(body.lastName);
  if (storage.normalizeName(firstName).length < MIN_NAME_CHARS
      || storage.normalizeName(lastName).length < MIN_NAME_CHARS) {
    context.res = { status: 400, headers: cors, body: { error: 'name_too_short' } };
    return;
  }

  let match;
  try {
    match = await storage.findInviteByPrimaryName(firstName, lastName);
  } catch (err) {
    context.log.error(`rsvp_lookup storage err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  if (!match) {
    context.log(`rsvp_lookup miss ipHash=${ipHash}`);
    context.res = {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { found: false }
    };
    return;
  }

  if (match.ambiguous) {
    // Two invites have the same primary first+last name. Don't pick one —
    // we'd authenticate the wrong household. Tell the user to contact us.
    context.log(`rsvp_lookup AMBIGUOUS ipHash=${ipHash} matchCount=${match.matchCount}`);
    context.res = {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { found: false, ambiguous: true }
    };
    return;
  }

  let invite;
  try {
    invite = await storage.getInvite(match.inviteId);
  } catch (err) {
    context.log.error(`rsvp_lookup hydrate err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  if (!invite) {
    // Filter returned an id but the row vanished between the two calls.
    context.res = { status: 200, headers: cors, body: { found: false } };
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

  context.log(`rsvp_lookup hit ipHash=${ipHash} inviteId=${invite.inviteId}`);
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
