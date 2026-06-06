'use strict';

// POST /api/rsvp/verify_code -- step-up auth, OTP-verify path.
//
// Requires a valid rsvp_ticket cookie (issued by /api/rsvp/lookup) and the
// 6-digit code sent by /api/rsvp/send_code. On success: issues the session
// cookie, deletes the verify-code row, and clears the ticket cookie. On
// failure: increments the per-row attempt counter; after 5 wrong tries the
// row is wiped and the user has to request a fresh code.
//
// Response (success): { ok: true } + Set-Cookie: rsvp_session + cleared ticket.
// Response (failure): { ok: false, reason: 'invalid_code', remaining: N }
//                  or { ok: false, reason: 'locked' }
//                  or { ok: false, reason: 'expired' | 'no_code' }
// Never echoes the code. Never logs the code. Hash compare is constant-time.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const ratelimit = require('../_lib/ratelimit');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

const MAX_ATTEMPTS = 5;
const PER_IP_LIMIT = 30;             // generous; covers retypes
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 1024;

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
  if (req.rawBody && typeof req.rawBody === 'string' && req.rawBody.length > MAX_BODY_BYTES) {
    context.res = { status: 413, headers: cors, body: { error: 'payload_too_large' } };
    return;
  }

  const ip = ratelimit.clientIp(req);
  const ipHash = ratelimit.hashIp(ip);
  const ipRl = ratelimit.check('rsvp_verify_code:ip', ip, PER_IP_LIMIT, RATE_WINDOW_MS);
  if (!ipRl.ok) {
    context.log(`rsvp_verify_code 429 ipHash=${ipHash}`);
    context.res = {
      status: 429,
      headers: { ...cors, 'Retry-After': String(ipRl.retryAfter) },
      body: { ok: false, reason: 'rate_limited', retryAfter: ipRl.retryAfter }
    };
    return;
  }

  let ticket;
  try {
    ticket = auth.verifyLookupTicket(req);
  } catch (err) {
    context.log.error(`rsvp_verify_code ticket err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }
  if (!ticket) {
    context.log(`rsvp_verify_code no-ticket ipHash=${ipHash}`);
    context.res = { status: 401, headers: cors, body: { error: 'no_ticket' } };
    return;
  }
  const { inviteId } = ticket;

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { body = null; }
  if (!body || typeof body !== 'object') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_json' } };
    return;
  }

  const submitted = typeof body.code === 'string'
    ? body.code.replace(/\D/g, '').slice(0, 6)
    : '';
  if (submitted.length !== 6) {
    context.res = { status: 400, headers: cors, body: { ok: false, reason: 'invalid_code_format' } };
    return;
  }

  let row;
  try {
    row = await storage.getVerifyCode(inviteId);
  } catch (err) {
    context.log.error(`rsvp_verify_code storage err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  if (!row || !row.codeHash) {
    context.log(`rsvp_verify_code no-code inviteId=${inviteId} ipHash=${ipHash}`);
    context.res = { status: 400, headers: cors, body: { ok: false, reason: 'no_code' } };
    return;
  }
  if (row.expiresAtMs && Date.now() > row.expiresAtMs) {
    try { await storage.deleteVerifyCode(inviteId); } catch { /* swallow */ }
    context.log(`rsvp_verify_code expired inviteId=${inviteId} ipHash=${ipHash}`);
    context.res = { status: 400, headers: cors, body: { ok: false, reason: 'expired' } };
    return;
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    try { await storage.deleteVerifyCode(inviteId); } catch { /* swallow */ }
    context.log(`rsvp_verify_code locked inviteId=${inviteId} ipHash=${ipHash}`);
    context.res = { status: 429, headers: cors, body: { ok: false, reason: 'locked' } };
    return;
  }

  const submittedHash = auth.hashVerifyCode(submitted);
  const match = auth.constantTimeEqual(submittedHash, row.codeHash);

  if (!match) {
    let attempts;
    try {
      attempts = await storage.incrementVerifyAttempts(inviteId);
    } catch (err) {
      context.log.error(`rsvp_verify_code inc err: ${err && err.message}`);
      attempts = (row.attempts || 0) + 1;
    }
    const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
    context.log(`rsvp_verify_code wrong inviteId=${inviteId} ipHash=${ipHash} attempts=${attempts}`);
    if (remaining === 0) {
      try { await storage.deleteVerifyCode(inviteId); } catch { /* swallow */ }
      context.res = { status: 429, headers: cors, body: { ok: false, reason: 'locked' } };
      return;
    }
    context.res = {
      status: 400,
      headers: { ...cors, 'Cache-Control': 'no-store' },
      body: { ok: false, reason: 'invalid_code', remaining }
    };
    return;
  }

  // Success. Burn the code, clear the ticket, issue the long-lived session.
  try { await storage.deleteVerifyCode(inviteId); } catch (err) {
    context.log.error(`rsvp_verify_code delete-after-ok err: ${err && err.message}`);
    // Soft-fail: don't block login over cleanup.
  }
  let sessionCookie;
  try {
    sessionCookie = auth.issueSessionCookie(inviteId);
  } catch (err) {
    context.log.error(`rsvp_verify_code session err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }

  context.log(`rsvp_verify_code ok inviteId=${inviteId} ipHash=${ipHash}`);
  context.res = {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // multi-Set-Cookie via array — Azure Functions serializes both headers.
      'Set-Cookie': [sessionCookie, auth.clearLookupTicketCookie()]
    },
    body: { ok: true }
  };
};
