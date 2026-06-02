'use strict';

// POST /api/rsvp/logout — clears the RSVP session cookie. Used by the
// "Not you?" button on shared-device flows and the magic-link "this
// isn't me" error state.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');

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

  context.res = {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': auth.clearSessionCookie()
    },
    body: { ok: true }
  };
};
