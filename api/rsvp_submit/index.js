'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const ratelimit = require('../_lib/ratelimit');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const { validatePayload, isComplete } = require('../_lib/payload');

const RATE_LIMIT_PER_MIN = 10;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 48 * 1024; // payload cap is 32k, plus envelope headroom

const PERMANENT_LOCK_UTC = new Date(process.env.RSVP_PERMANENT_LOCK_UTC || '2027-01-15T23:59:59-05:00');
const GUEST_DEADLINE_UTC = new Date(process.env.RSVP_GUEST_DEADLINE_UTC || '2026-11-15T23:59:59-05:00');

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
  const rl = ratelimit.check('rsvp_submit', ip, RATE_LIMIT_PER_MIN, RATE_WINDOW_MS);
  if (!rl.ok) {
    context.log(`rsvp_submit 429 ipHash=${ipHash}`);
    context.res = {
      status: 429,
      headers: { ...cors, 'Retry-After': String(rl.retryAfter) },
      body: { error: 'rate_limited', retryAfter: rl.retryAfter }
    };
    return;
  }

  const now = new Date();
  if (now > PERMANENT_LOCK_UTC) {
    context.res = {
      status: 410,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: { error: 'rsvp_closed', message: 'RSVP submissions are closed. Please contact the couple directly.' }
    };
    return;
  }

  // Auth via session cookie
  let session;
  try {
    session = auth.verifySessionCookie(req);
  } catch (err) {
    context.log.error(`rsvp_submit cookie config err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }
  if (!session) {
    context.res = { status: 401, headers: cors, body: { error: 'session_required' } };
    return;
  }
  const { inviteId } = session;

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { body = null; }
  if (!body || typeof body !== 'object') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_json' } };
    return;
  }
  if (!body.payload || typeof body.payload !== 'object') {
    context.res = { status: 400, headers: cors, body: { error: 'payload_required' } };
    return;
  }

  // Strict validation — every attending must be answered (the public form
  // is a final submit, not a draft save).
  const v = validatePayload(body.payload, { requireAttending: true });
  if (!v.ok) {
    context.res = { status: 400, headers: cors, body: { error: v.error, detail: v.detail } };
    return;
  }

  // Confirm the invite still exists.
  let invite;
  try {
    invite = await storage.getInvite(inviteId);
  } catch (err) {
    context.log.error(`rsvp_submit hydrate err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  if (!invite) {
    context.res = {
      status: 410,
      headers: { ...cors, 'Set-Cookie': auth.clearSessionCookie() },
      body: { error: 'invite_not_found' }
    };
    return;
  }

  const isLate = now > GUEST_DEADLINE_UTC;
  try {
    await storage.markResponded(inviteId, v.json, { late: isLate, respondedAt: now.toISOString() });
  } catch (err) {
    context.log.error(`rsvp_submit write err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  context.log(`rsvp_submit ok ipHash=${ipHash} inviteId=${inviteId} guests=${v.payload.additionalGuests.length} complete=${isComplete(v.payload)} late=${isLate}`);

  try {
    const guestCount = v.payload.additionalGuests.length + 1;
    const complete = isComplete(v.payload);
    await storage.appendEvent({
      type: 'rsvp.submitted',
      actor: `invitee:${invite.primaryFirstName} ${invite.primaryLastName}`.trim(),
      summary: `RSVP submitted for ${invite.primaryLastName} household (${guestCount} ${guestCount === 1 ? 'guest' : 'guests'}, ${complete ? 'complete' : 'partial'}${isLate ? ', late' : ''})`,
      meta: { inviteId, guestCount, complete, late: isLate }
    });
  } catch (err) {
    context.log.error(`rsvp_submit event_write_failed: ${err && err.message}`);
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: {
      ok: true,
      late: isLate,
      receivedAt: now.toISOString(),
      payload: v.payload
    }
  };
};
