'use strict';

// POST /api/mgmt/admin-login-verify
// Body: { t: string }
//
// POST (not GET) deliberately, so Gmail / Outlook / corporate proxy link-
// preview scanners cannot consume the magic token by simply requesting the
// URL. The user-facing /admin/login/confirm page renders a Sign In button
// that POSTs here when the human actually clicks it.
//
// On success: sets the admin_session cookie and returns { ok:true, redirect:'/admin' }.
// On failure: returns 400 with { error:'expired'|'invalid'|'replayed' }.

const crypto = require('crypto');
const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const rl = require('../_lib/ratelimit');
const storage = require('../_lib/storage');

function emailKey(emailLower) {
  return crypto.createHash('sha256').update(`admin-login|${emailLower}`).digest('hex').slice(0, 16);
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

  // Rate-limit verify too -- defends against a leaked-token brute-force
  // attempt where an attacker iterates nonces.
  const ip = rl.clientIp(req);
  const ipKey = rl.hashIp(ip);
  const ipLimit = rl.check('admin_verify_ip', ipKey, 10, 5 * 60 * 1000);
  if (!ipLimit.ok) {
    context.log(`admin_login_verify rate_limited ip=${ipKey}`);
    context.res = {
      status: 429,
      headers: { ...cors, 'Retry-After': String(ipLimit.retryAfter || 60) },
      body: { error: 'rate_limited' }
    };
    return;
  }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { payload = null; }
  const token = (payload && typeof payload.t === 'string') ? payload.t : '';
  if (!token) {
    context.res = { status: 400, headers: cors, body: { error: 'invalid' } };
    return;
  }

  let verified;
  try {
    verified = auth.verifyAdminMagicToken(token);
  } catch (err) {
    context.log.error(`admin_login_verify config_err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'service_unavailable' } };
    return;
  }
  if (!verified) {
    // verifyAdminMagicToken returns null for "any failure" so we don't
    // distinguish bad-sig vs expired vs malformed at the API boundary.
    // The audit log records the input length only to help diagnose
    // truncated-token bug reports without leaking the token itself.
    context.log(`admin_login_verify bad_token len=${token.length}`);
    try {
      await storage.appendEvent({
        type: 'admin.login.verify_failed',
        actor: 'unknown',
        summary: 'Invalid or expired token',
        meta: { ipKey, tokenLen: token.length }
      });
    } catch {}
    context.res = { status: 400, headers: cors, body: { error: 'invalid' } };
    return;
  }

  // Re-check allowlist at verify time so removing someone from
  // ADMIN_EMAIL_ALLOWLIST invalidates any in-flight links even if their
  // signature still validates.
  if (!auth.isAdminEmail(verified.email)) {
    context.log(`admin_login_verify not_allowlisted email_hash=${emailKey(verified.email)}`);
    try {
      await storage.appendEvent({
        type: 'admin.login.verify_failed',
        actor: `email_hash:${emailKey(verified.email)}`,
        summary: 'Email no longer on allowlist',
        meta: { ipKey }
      });
    } catch {}
    context.res = { status: 400, headers: cors, body: { error: 'invalid' } };
    return;
  }

  // Atomic single-use claim. If the row already exists, someone (probably
  // the user themselves with a stale tab, possibly an attacker) already
  // used this nonce.
  const expiresIso = new Date(verified.expiresAtMs).toISOString();
  let claim;
  try {
    claim = await storage.claimAdminNonce(verified.email, verified.nonceHash, expiresIso);
  } catch (err) {
    context.log.error(`admin_login_verify claim_err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'service_unavailable' } };
    return;
  }
  if (!claim.claimed) {
    context.log(`admin_login_verify replayed email_hash=${emailKey(verified.email)} reason=${claim.reason}`);
    try {
      await storage.appendEvent({
        type: 'admin.login.verify_failed',
        actor: `email_hash:${emailKey(verified.email)}`,
        summary: `Token replay rejected (${claim.reason})`,
        meta: { ipKey, reason: claim.reason }
      });
    } catch {}
    context.res = { status: 400, headers: cors, body: { error: 'replayed' } };
    return;
  }

  // Mint the session cookie. The cookie is the only credential going
  // forward; the magic token is now spent.
  let cookie;
  try {
    cookie = auth.issueAdminSessionCookie(verified.email);
  } catch (err) {
    context.log.error(`admin_login_verify cookie_err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'service_unavailable' } };
    return;
  }

  try {
    await storage.appendEvent({
      type: 'admin.login.success',
      actor: `email:${verified.email}`,
      summary: `Admin signed in via email magic-link`,
      meta: { ipKey }
    });
  } catch (err) { context.log.error(`admin_login_verify event_write: ${err && err.message}`); }

  context.log(`admin_login_verify ok email=${verified.email}`);
  context.res = {
    status: 200,
    headers: { ...cors, 'Set-Cookie': cookie, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, redirect: '/admin' }
  };
};
