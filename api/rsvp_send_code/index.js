'use strict';

// POST /api/rsvp/send_code -- step-up auth, OTP path.
//
// Requires a valid rsvp_ticket cookie (issued by /api/rsvp/lookup). Generates
// a 6-digit one-time code, stores its HMAC hash with a 10-minute expiry in
// rsvpVerifyCodes, and sends it to the invite's registered phone via SMS.
//
// Rate-limiting (defense in depth, several layers):
//   - 60-second cooldown between sends per invite (read from rsvpVerifyCodes
//     sentAtMs to survive Function cold-starts that flush in-memory state)
//   - 5 sends per 10-minute window per invite (in-memory)
//   - 10 sends per 10-minute window per IP (in-memory; blunts a credential-
//     stuffer who rotates inviteIds via stolen tickets)
//
// Response shape: { ok: true } | { ok: false, reason: 'cooldown', retryAfter }
// Never echoes the code, the phone, or the magic token (would defeat the
// whole point if visible in the network tab).

const crypto = require('crypto');

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const ratelimit = require('../_lib/ratelimit');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const sms = require('../_lib/sms');

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const PER_INVITE_LIMIT = 5;
const PER_IP_LIMIT = 10;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function generateCode() {
  // crypto.randomInt is uniform — Math.random would be biased.
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

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
    context.log.error(`rsvp_send_code ticket err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }
  if (!ticket) {
    context.log(`rsvp_send_code no-ticket ipHash=${ipHash}`);
    context.res = { status: 401, headers: cors, body: { error: 'no_ticket' } };
    return;
  }
  const { inviteId } = ticket;

  // IP-level burst control. inviteId-level is enforced below via the table
  // (so cold-starts can't reset the cooldown).
  const ipRl = ratelimit.check('rsvp_send_code:ip', ip, PER_IP_LIMIT, RATE_WINDOW_MS);
  if (!ipRl.ok) {
    context.log(`rsvp_send_code 429 ipHash=${ipHash}`);
    context.res = {
      status: 429,
      headers: { ...cors, 'Retry-After': String(ipRl.retryAfter) },
      body: { ok: false, reason: 'rate_limited', retryAfter: ipRl.retryAfter }
    };
    return;
  }
  const inviteRl = ratelimit.check('rsvp_send_code:invite', inviteId, PER_INVITE_LIMIT, RATE_WINDOW_MS);
  if (!inviteRl.ok) {
    context.log(`rsvp_send_code 429-invite ipHash=${ipHash} inviteId=${inviteId}`);
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
    context.log.error(`rsvp_send_code storage err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  if (!invite) {
    // Stale ticket pointing at a deleted invite. Clear cookie so the client
    // restarts the flow cleanly.
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

  // Cross-cold-start cooldown via the persisted sentAtMs column. The
  // in-memory bucket above already caught most retries in the same warm
  // instance; this catches the case where the Function reloads between
  // requests and the bucket is empty.
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
    context.log.error(`rsvp_send_code cooldown-read err: ${err && err.message}`);
    // Soft-fail: don't block sending just because we couldn't read the table.
  }

  const code = generateCode();
  const codeHash = auth.hashVerifyCode(code);
  const sentAtMs = Date.now();
  const expiresAtMs = sentAtMs + CODE_TTL_MS;

  try {
    await storage.putVerifyCode(inviteId, {
      codeHash,
      expiresAtMs,
      sentVia: 'code',
      sentAtMs
    });
  } catch (err) {
    context.log.error(`rsvp_send_code put err inviteId=${inviteId}: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  const body = sms.buildVerifyCodeBody({ locale: invite.locale, code });
  let result;
  try {
    result = await sms.sendSms(invite.phoneNorm, body, { tag: 'rsvp-verify' });
  } catch (err) {
    context.log.error(`rsvp_send_code sms throw inviteId=${inviteId}: ${err && err.message}`);
    result = { successful: false, errorMessage: String(err && err.message), errorCode: 'EXCEPTION' };
  }

  if (!result.successful) {
    context.log(`rsvp_send_code sms-fail inviteId=${inviteId} code=${result.errorCode}`);
    // Wipe the stored hash so a retry can re-issue without colliding on the
    // cooldown (and so the unused hash isn't sitting in storage).
    try { await storage.deleteVerifyCode(inviteId); } catch { /* swallow */ }
    context.res = {
      status: 502,
      headers: cors,
      body: { ok: false, reason: 'sms_failed' }
    };
    return;
  }

  context.log(`rsvp_send_code ok inviteId=${inviteId} ipHash=${ipHash} seg=${result.segmentCount}`);

  // Audit row so Twilio status callbacks can patch deliveryStatus, and
  // operators can see verify SMS in the per-invite log alongside reminders.
  // Body is template-only — the OTP itself stays out of storage.
  try {
    await storage.appendSmsLog(inviteId, {
      type: 'verify_code',
      body: `[verify_code:${invite.locale || 'en'}] code redacted, ttl=10m`,
      toPhone: invite.phoneNorm,
      deliveryStatus: 'pending',
      sentAt: new Date(sentAtMs).toISOString(),
      correlationId: result.messageId || ''
    });
  } catch (err) {
    context.log.error(`rsvp_send_code smslog err inviteId=${inviteId}: ${err && err.message}`);
    // Soft-fail: SMS already went out; missing audit row is annoying but
    // doesn't compromise correctness.
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Cache-Control': 'no-store' },
    body: { ok: true }
  };
};
