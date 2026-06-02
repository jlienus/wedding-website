'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const ratelimit = require('../_lib/ratelimit');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

const RATE_LIMIT_PER_MIN = 10;
const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_FIELD_CHARS = 800;

// Final permanent lock: after this datetime the form 410s, no admin override
// from the public endpoint (admin can still edit via /api/admin/*).
const PERMANENT_LOCK_UTC = new Date(process.env.RSVP_PERMANENT_LOCK_UTC || '2027-01-15T23:59:59-05:00');

// Public guest-facing deadline. Submissions after this still accepted (per
// user direction — reminders continue through Jan 15) but flagged "late".
const GUEST_DEADLINE_UTC = new Date(process.env.RSVP_GUEST_DEADLINE_UTC || '2026-11-15T23:59:59-05:00');

const VALID_MEAL_CHOICES = new Set(['chicken', 'beef', 'vegetarian', 'vegan', 'kids', '']);

function clipString(v) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, MAX_FIELD_CHARS);
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

  // Permanent lock check
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
  const { partyId } = session;

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { payload = null; }
  if (!payload || typeof payload !== 'object') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_json' } };
    return;
  }
  if (!Array.isArray(payload.members)) {
    context.res = { status: 400, headers: cors, body: { error: 'members_required' } };
    return;
  }

  // Verify the party still exists and members belong to it.
  let party, members;
  try {
    [party, members] = await Promise.all([
      storage.getParty(partyId),
      storage.listMembers(partyId)
    ]);
  } catch (err) {
    context.log.error(`rsvp_submit hydrate err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  if (!party) {
    context.res = { status: 410, headers: cors, body: { error: 'party_not_found' } };
    return;
  }

  const memberById = new Map(members.map((m) => [m.memberId, m]));

  // Validate each member payload, then persist.
  const sanitized = [];
  for (const m of payload.members) {
    if (!m || typeof m !== 'object') {
      context.res = { status: 400, headers: cors, body: { error: 'member_invalid' } };
      return;
    }
    const memberId = String(m.memberId || '');
    const member = memberById.get(memberId);
    if (!member) {
      context.res = { status: 400, headers: cors, body: { error: 'unknown_member', memberId } };
      return;
    }
    // Require a real tri-state: true / false / null. Reject undefined or
    // truthy strings — those typically indicate a client-side bug we'd
    // rather know about than silently coerce.
    let attending;
    if (m.attending === null || m.attending === true || m.attending === false) {
      attending = m.attending;
    } else {
      context.res = { status: 400, headers: cors, body: { error: 'attending_invalid', memberId } };
      return;
    }
    const mealChoice = clipString(m.mealChoice).toLowerCase();
    if (!VALID_MEAL_CHOICES.has(mealChoice)) {
      context.res = { status: 400, headers: cors, body: { error: 'bad_meal_choice', mealChoice } };
      return;
    }
    // Only let the actual plus-one slot (when allowed) carry a plus-one
    // name. Otherwise drop it so a crafted request can't smuggle in extra
    // attendees.
    const plusOneAllowedHere = !!party.plusOneAllowed && member.role === 'plusone';
    const plusOneName = plusOneAllowedHere ? clipString(m.plusOneName) : '';
    sanitized.push({
      memberId,
      attending,
      mealChoice,
      dietary: clipString(m.dietary),
      songRequest: clipString(m.songRequest),
      notes: clipString(m.notes),
      plusOneName
    });
  }

  const isLate = now > GUEST_DEADLINE_UTC;
  try {
    for (const fields of sanitized) {
      await storage.upsertResponse(partyId, fields.memberId, {
        ...fields,
        submittedByMethod: isLate ? 'web-late' : 'web',
        sourceIpHash: ipHash
      });
    }
  } catch (err) {
    context.log.error(`rsvp_submit write err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  context.log(`rsvp_submit ok ipHash=${ipHash} partyId=${partyId} members=${sanitized.length} late=${isLate}`);
  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: {
      ok: true,
      late: isLate,
      receivedAt: now.toISOString()
    }
  };
};
