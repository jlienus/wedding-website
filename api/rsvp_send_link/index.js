'use strict';

// POST /api/rsvp/send_link -- step-up auth, magic-link path.
//
// Requires a valid rsvp_ticket cookie (issued by /api/rsvp/lookup). Mints a
// TTL'd magic-link token via auth.signVerifyMagicToken (10-minute expiry,
// distinct purpose tag from the long-lived reminder magic link), then SMSes
// the resulting URL to the invite's registered phone.
//
// Rate-limiting mirrors rsvp_send_code: 60-sec cooldown per invite, 5 sends
// per 10 min per invite, 10 sends per 10 min per IP. The cooldown is shared
// with send_code (both paths write the same rsvpVerifyCodes row) so a guest
// can't bypass the cooldown by alternating between the two flavors.
//
// Response: { ok: true } | { ok: false, reason: '...' }. Never echoes the
// phone or the magic token.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const ratelimit = require('../_lib/ratelimit');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const sms = require('../_lib/sms');

const RESEND_COOLDOWN_MS = 60 * 1000;
const TTL_MS = 10 * 60 * 1000;
const PER_INVITE_LIMIT = 5;
const PER_IP_LIMIT = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;

const SITE_ORIGIN = process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com';

module.exports = async function (context, req) {
  const pre = preflight(req, 'POST, OPTIONS');
  if (pre.handled) { context.res = pre.response; return; }
  const { cors, origin } = pre;

  if (req.method !== 'POST') {
    context.res = { status: 405, headers: cors, body: { error: 'method_not_allowed' } };
    return;
  }
  if (!isAllowedOrigin(origin)) {
    context.res = { status: 403, headers: cors, body: { error: 'origin_not_allowed' } };
    return;
  }

  const ip = ratelimit.clientIp(req);
  const ipHash = ratelimit.hashIp(ip);

  let ticket;
  try {
    ticket = auth.verifyLookupTicket(req);
  } catch (err) {
    context.log.error(`rsvp_send_link ticket err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }
  if (!ticket) {
    context.log(`rsvp_send_link no-ticket ipHash=${ipHash}`);
    context.res = { status: 401, headers: cors, body: { error: 'no_ticket' } };
    return;
  }
  const { inviteId } = ticket;

  // Shared bucket name with rsvp_send_code intentionally — alternating
  // between code and link to bypass the per-invite limit would be a trivial
  // workaround.
  const ipRl = ratelimit.check('rsvp_send_code:ip', ip, PER_IP_LIMIT, RATE_WINDOW_MS);
  if (!ipRl.ok) {
    context.log(`rsvp_send_link 429 ipHash=${ipHash}`);
    context.res = {
      status: 429,
      headers: { ...cors, 'Retry-After': String(ipRl.retryAfter) },
      body: { ok: false, reason: 'rate_limited', retryAfter: ipRl.retryAfter }
    };
    return;
  }
  const inviteRl = ratelimit.check('rsvp_send_code:invite', inviteId, PER_INVITE_LIMIT, RATE_WINDOW_MS);
  if (!inviteRl.ok) {
    context.log(`rsvp_send_link 429-invite ipHash=${ipHash} inviteId=${inviteId}`);
    context.res = {
      status: 429,
      headers: { ...cors, 'Retry-After': String(inviteRl.retryAfter) },
      body: { ok: false, reason: 'rate_limited', retryAfter: inviteRl.retryAfter }
    };
    return;
  }

  let invite;
  try {
    invite = await storage.getInvite(inviteId);
  } catch (err) {
    context.log.error(`rsvp_send_link storage err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  if (!invite) {
    context.res = {
      status: 200,
      headers: { ...cors, 'Set-Cookie': auth.clearLookupTicketCookie() },
      body: { ok: false, reason: 'invite_not_found' }
    };
    return;
  }
  if (!invite.phoneNorm) {
    context.res = { status: 400, headers: cors, body: { ok: false, reason: 'no_phone' } };
    return;
  }
  if (invite.optedOutOfSms || invite.smsHardFailedAt) {
    context.res = { status: 400, headers: cors, body: { ok: false, reason: 'sms_unavailable' } };
    return;
  }

  // Cross-cold-start cooldown via the same rsvpVerifyCodes row used by
  // send_code, so the two paths can't be alternated to bypass the 60-sec
  // pause between sends.
  try {
    const existing = await storage.getVerifyCode(inviteId);
    if (existing && existing.sentAtMs) {
      const elapsed = Date.now() - existing.sentAtMs;
      if (elapsed >= 0 && elapsed < RESEND_COOLDOWN_MS) {
        const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        context.res = {
          status: 429,
          headers: { ...cors, 'Retry-After': String(retryAfter) },
          body: { ok: false, reason: 'cooldown', retryAfter }
        };
        return;
      }
    }
  } catch (err) {
    context.log.error(`rsvp_send_link cooldown-read err: ${err && err.message}`);
  }

  const sentAtMs = Date.now();

  // The link path doesn't need a server-side hash to verify against (the
  // token signature does that), but we still write a row so the shared
  // cooldown above sees the send. We deliberately store an empty codeHash
  // — if a stale row from a prior send_code call has a real hash, that
  // hash is now invalid because the user picked the link path, so we want
  // to wipe it.
  try {
    await storage.putVerifyCode(inviteId, {
      codeHash: '',
      expiresAtMs: sentAtMs + TTL_MS,
      sentVia: 'link',
      sentAtMs
    });
  } catch (err) {
    context.log.error(`rsvp_send_link put err inviteId=${inviteId}: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  let magicToken;
  try {
    magicToken = auth.signVerifyMagicToken(inviteId);
  } catch (err) {
    context.log.error(`rsvp_send_link sign err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }

  const body = sms.buildVerifyLinkBody({
    locale: invite.locale,
    siteOrigin: SITE_ORIGIN,
    magicToken
  });

  let result;
  try {
    result = await sms.sendSms(invite.phoneNorm, body, { tag: 'rsvp-verify' });
  } catch (err) {
    context.log.error(`rsvp_send_link sms throw inviteId=${inviteId}: ${err && err.message}`);
    result = { successful: false, errorMessage: String(err && err.message), errorCode: 'EXCEPTION' };
  }

  if (!result.successful) {
    context.log(`rsvp_send_link sms-fail inviteId=${inviteId} code=${result.errorCode}`);
    try { await storage.deleteVerifyCode(inviteId); } catch { /* swallow */ }
    context.res = {
      status: 502,
      headers: cors,
      body: { ok: false, reason: 'sms_failed' }
    };
    return;
  }

  context.log(`rsvp_send_link ok inviteId=${inviteId} ipHash=${ipHash} seg=${result.segmentCount}`);
  context.res = {
    status: 200,
    headers: { ...cors, 'Cache-Control': 'no-store' },
    body: { ok: true }
  };
};
