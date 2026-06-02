'use strict';

const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

const SITE_ORIGIN = process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com';

// GET /api/rsvp/magic?t=<partyId>.<sig>
// Magic link arriving from an SMS reminder. Verifies the HMAC, issues a
// session cookie, and 302-redirects to /rsvp (or /es/rsvp if the party
// locale is es).
module.exports = async function (context, req) {
  const token = (req.query && (req.query.t || req.query.T)) || '';

  let partyId;
  try {
    partyId = auth.verifyMagicToken(token);
  } catch (err) {
    context.log.error(`rsvp_magic config err: ${err && err.message}`);
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=error`, null);
    return;
  }
  if (!partyId) {
    context.log(`rsvp_magic bad token`);
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=invalid`, null);
    return;
  }

  // Confirm party still exists and pick redirect locale.
  let party;
  try {
    party = await storage.getParty(partyId);
  } catch (err) {
    context.log.error(`rsvp_magic storage err: ${err && err.message}`);
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=error`, null);
    return;
  }
  if (!party) {
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=missing`, null);
    return;
  }

  let cookie;
  try {
    cookie = auth.issueSessionCookie(partyId);
  } catch (err) {
    context.log.error(`rsvp_magic cookie err: ${err && err.message}`);
    context.res = redirectTo(`${SITE_ORIGIN}/rsvp?magic=error`, null);
    return;
  }

  const target = party.locale === 'es'
    ? `${SITE_ORIGIN}/es/rsvp?magic=ok`
    : `${SITE_ORIGIN}/rsvp?magic=ok`;

  context.log(`rsvp_magic ok partyId=${partyId} locale=${party.locale}`);
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
