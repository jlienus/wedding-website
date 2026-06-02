'use strict';

const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

const SITE_ORIGIN = process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com';

// GET /api/rsvp/magic?t=<inviteId>.<sig>
// Magic link arriving from an SMS reminder. Verifies the HMAC, issues a
// session cookie, and 302-redirects to /rsvp (or /es/rsvp if the invite
// locale is es).
module.exports = async function (context, req) {
  const token = (req.query && (req.query.t || req.query.T)) || '';

  let inviteId;
  try {
    inviteId = auth.verifyMagicToken(token);
  } catch (err) {
    context.log.error(`rsvp_magic config err: ${err && err.message}`);
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=error`, null);
    return;
  }
  if (!inviteId) {
    context.log(`rsvp_magic bad token`);
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=invalid`, null);
    return;
  }

  let invite;
  try {
    invite = await storage.getInvite(inviteId);
  } catch (err) {
    context.log.error(`rsvp_magic storage err: ${err && err.message}`);
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=error`, null);
    return;
  }
  if (!invite) {
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=missing`, null);
    return;
  }

  let cookie;
  try {
    cookie = auth.issueSessionCookie(inviteId);
  } catch (err) {
    context.log.error(`rsvp_magic cookie err: ${err && err.message}`);
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=error`, null);
    return;
  }

  const target = invite.locale === 'es'
    ? `${SITE_ORIGIN}/es/rsvp?magic=ok`
    : `${SITE_ORIGIN}/rsvp?magic=ok`;

  context.log(`rsvp_magic ok inviteId=${inviteId} locale=${invite.locale}`);
  context.res = redirectTo(target, cookie);
};

function redirectTo(url, cookie) {
  const headers = {
    'Location': url,
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8'
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  return {
    status: 302,
    headers,
    body: `Redirecting to ${url}`
  };
}
