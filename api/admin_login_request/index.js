'use strict';

// POST /api/mgmt/admin-login-request
// Body: { email: string }
//
// Public endpoint -- NOT gated by isAdmin. Anyone can POST here.
//
// Always returns 200 with the same generic message regardless of whether
// the email is on the allowlist. This is the "no enumeration" property:
// an attacker who probes random emails learns nothing about which (if any)
// addresses are authorized. The ONLY observable side effect when the email
// IS allowlisted is that an email is sent to that mailbox -- which the
// attacker cannot see unless they already control the mailbox.
//
// If the request looks invalid OR rate-limited we still return 200 to keep
// timing/response shape constant. Server-side audit events distinguish the
// internal outcome for diagnostics.

const crypto = require('crypto');
const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const rl = require('../_lib/ratelimit');
const email = require('../_lib/email');
const storage = require('../_lib/storage');

const SITE_ORIGIN = process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com';

const GENERIC_OK_BODY = {
  ok: true,
  message: 'If that email is on the admin list, a sign-in link is on its way. Check spam if you don\'t see it within a minute.'
};

function emailKey(emailLower) {
  // Hash the email for rate-limit bucketing so the in-memory map keys
  // don't carry plaintext addresses for any longer than the request.
  return crypto.createHash('sha256').update(`admin-login|${emailLower}`).digest('hex').slice(0, 16);
}

function buildLinkHtml({ link, expiresMin }) {
  // Plain HTML, no external assets, no tracking pixels. We display the link
  // text literally so the recipient can verify the destination before clicking.
  const escapedLink = String(link).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [
    '<!doctype html>',
    '<html><body style="font-family:Georgia,serif;max-width:560px;margin:24px auto;line-height:1.5;color:#1a1a1a;">',
    '<h2 style="font-weight:400;letter-spacing:0.02em;">John &amp; Diana &mdash; admin sign-in</h2>',
    `<p>Click the button below within ${expiresMin} minutes to sign in to the wedding RSVP admin dashboard.</p>`,
    `<p style="margin:28px 0;"><a href="${escapedLink}" style="display:inline-block;background:#1a1a1a;color:#faf8f4;text-decoration:none;padding:12px 24px;border-radius:4px;font-size:15px;letter-spacing:0.04em;">Sign in to admin</a></p>`,
    `<p style="font-size:13px;color:#555;">Or paste this link in your browser:<br><span style="word-break:break-all;">${escapedLink}</span></p>`,
    '<p style="font-size:12px;color:#888;margin-top:32px;">If you didn\'t request this, you can safely ignore this email &mdash; the link expires on its own.</p>',
    '</body></html>'
  ].join('');
}

function buildLinkText({ link, expiresMin }) {
  return [
    'John & Diana -- admin sign-in',
    '',
    `Click the link below within ${expiresMin} minutes to sign in:`,
    link,
    '',
    'If you didn\'t request this, you can safely ignore this email -- the link expires on its own.'
  ].join('\n');
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

  // Parse + minimally validate. Anything malformed still returns the same
  // generic OK so error shape doesn't leak structure.
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { payload = null; }
  const rawEmail = (payload && typeof payload.email === 'string') ? payload.email : '';
  const emailLower = auth.normalizeEmail(rawEmail);
  const validShape = auth.isLikelyEmail(emailLower);

  // Rate-limit by IP and by hashed-email. Tight enough that an attacker
  // can't iterate the entire allowlist by retrying repeatedly from one IP,
  // generous enough that a real admin who triggers a typo can still
  // succeed within a minute.
  const ip = rl.clientIp(req);
  const ipKey = rl.hashIp(ip);
  const ipLimit = rl.check('admin_login_ip', ipKey, 5, 15 * 60 * 1000);
  const emailLimit = validShape ? rl.check('admin_login_email', emailKey(emailLower), 3, 15 * 60 * 1000) : { ok: true };

  // Log the rate-limit outcome for diagnostics but DON'T change the
  // response shape.
  if (!ipLimit.ok) {
    context.log(`admin_login_request rate_limited_ip ip=${ipKey} retryAfter=${ipLimit.retryAfter}`);
  } else if (!emailLimit.ok) {
    context.log(`admin_login_request rate_limited_email retryAfter=${emailLimit.retryAfter}`);
  }

  // Always-OK response. Internal short-circuits below skip the actual send.
  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: GENERIC_OK_BODY
  };

  if (!validShape || !ipLimit.ok || !emailLimit.ok) {
    try {
      await storage.appendEvent({
        type: 'admin.login.requested',
        actor: validShape ? `email_hash:${emailKey(emailLower)}` : 'invalid_shape',
        summary: !validShape
          ? 'Malformed email rejected'
          : (!ipLimit.ok ? 'IP rate-limited (no send)' : 'Email rate-limited (no send)'),
        meta: {
          ipKey,
          ipLimited: !ipLimit.ok,
          emailLimited: !emailLimit.ok,
          validShape
        }
      });
    } catch (err) { context.log.error(`admin_login_request event_write: ${err && err.message}`); }
    return;
  }

  // Allowlist check is constant-time inside isAdminEmail. Non-listed emails
  // produce a no-op send to keep the timing/response observable identical.
  const allowed = auth.isAdminEmail(emailLower);
  if (!allowed) {
    try {
      await storage.appendEvent({
        type: 'admin.login.requested',
        actor: `email_hash:${emailKey(emailLower)}`,
        summary: 'Not on allowlist (no send)',
        meta: { ipKey, allowed: false }
      });
    } catch (err) { context.log.error(`admin_login_request event_write: ${err && err.message}`); }
    return;
  }

  // Allowlisted: mint a magic token and send the email.
  let mint;
  try {
    mint = auth.signAdminMagicToken(emailLower);
  } catch (err) {
    context.log.error(`admin_login_request mint_failed: ${err && err.message}`);
    try {
      await storage.appendEvent({
        type: 'admin.login.email_send_failed',
        actor: `email_hash:${emailKey(emailLower)}`,
        summary: `Token mint failed: ${err && err.message}`,
        meta: { ipKey }
      });
    } catch {}
    return;
  }

  const confirmUrl = `${SITE_ORIGIN}/admin/login/confirm?t=${encodeURIComponent(mint.token)}`;
  const expiresMin = Math.max(1, Math.round(auth.ADMIN_MAGIC_MAX_AGE_SEC / 60));
  const html = buildLinkHtml({ link: confirmUrl, expiresMin });
  const plainText = buildLinkText({ link: confirmUrl, expiresMin });

  let sendResult;
  try {
    sendResult = await email.sendEmail({
      to: emailLower,
      subject: 'John & Diana admin sign-in link',
      html,
      plainText
    });
  } catch (err) {
    context.log.error(`admin_login_request send_exception: ${err && err.message}`);
    try {
      await storage.appendEvent({
        type: 'admin.login.email_send_failed',
        actor: `email_hash:${emailKey(emailLower)}`,
        summary: `Email send threw: ${err && err.message}`,
        meta: { ipKey }
      });
    } catch {}
    return;
  }

  if (!sendResult.successful) {
    context.log(`admin_login_request send_failed status=${sendResult.status} code=${sendResult.errorCode}`);
    try {
      await storage.appendEvent({
        type: 'admin.login.email_send_failed',
        actor: `email_hash:${emailKey(emailLower)}`,
        summary: `Email send failed: ${sendResult.errorCode || sendResult.status}`,
        meta: {
          ipKey,
          status: sendResult.status,
          errorCode: sendResult.errorCode,
          errorMessage: sendResult.errorMessage,
          messageId: sendResult.messageId
        }
      });
    } catch {}
    return;
  }

  context.log(`admin_login_request sent emailKey=${emailKey(emailLower)} messageId=${sendResult.messageId}`);
  try {
    await storage.appendEvent({
      type: 'admin.login.requested',
      actor: `email_hash:${emailKey(emailLower)}`,
      summary: 'Magic link emailed',
      meta: {
        ipKey,
        allowed: true,
        messageId: sendResult.messageId,
        expiresAtMs: mint.expiresAtMs
      }
    });
  } catch (err) { context.log.error(`admin_login_request event_write: ${err && err.message}`); }
};
