'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const { emptyPayload } = require('../_lib/payload');

// GET /api/rsvp/get — reads the session cookie and returns the invite +
// saved payload. Used by the form on return visits and after a magic-link
// redirect. No body needed.
module.exports = async function (context, req) {
  const pre = preflight(req, 'GET, OPTIONS');
  if (pre.handled) { context.res = pre.response; return; }
  const { cors, origin } = pre;

  if (req.method !== 'GET') {
    context.res = { status: 405, headers: cors, body: { error: 'Method not allowed' } };
    return;
  }
  if (origin && !isAllowedOrigin(origin)) {
    context.res = { status: 403, headers: cors, body: { error: 'Origin not allowed' } };
    return;
  }

  let session;
  try {
    session = auth.verifySessionCookie(req);
  } catch (err) {
    context.log.error(`rsvp_get cookie err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }
  if (!session) {
    context.res = {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { authenticated: false }
    };
    return;
  }

  const { inviteId } = session;

  let invite;
  try {
    invite = await storage.getInvite(inviteId);
  } catch (err) {
    context.log.error(`rsvp_get storage err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  if (!invite) {
    // Cookie pointed to a deleted invite. Clear cookie.
    context.res = {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Set-Cookie': auth.clearSessionCookie() },
      body: { authenticated: false, reason: 'invite_not_found' }
    };
    return;
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: {
      authenticated: true,
      invite: {
        inviteId: invite.inviteId,
        primaryFirstName: invite.primaryFirstName,
        primaryLastName: invite.primaryLastName,
        locale: invite.locale,
        hasPhone: !!invite.phoneNorm,
        payload: invite.payload || emptyPayload(),
        responded: !!invite.responded,
        respondedAt: invite.respondedAt || ''
      }
    }
  };
};
