'use strict';

// GET /api/mgmt/admin-whoami
//
// Returns the current admin auth state -- which path (github / email),
// the displayable label, and whether the caller is authed at all.
// Used by the admin gate UI to decide whether to show the dashboard or
// the sign-in chooser.
//
// Always returns 200 so the gate page can render the same shell either way.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');

module.exports = async function (context, req) {
  const pre = preflight(req, 'GET, OPTIONS');
  if (pre.handled) { context.res = pre.response; return; }
  const { cors, origin } = pre;

  if (req.method !== 'GET') {
    context.res = { status: 405, headers: cors, body: { error: 'method_not_allowed' } };
    return;
  }
  if (origin && !isAllowedOrigin(origin)) {
    context.res = { status: 403, headers: cors, body: { error: 'origin_not_allowed' } };
    return;
  }

  const headers = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (auth.isAdminGitHub(req)) {
    const principal = auth.readAdminPrincipal(req) || {};
    context.res = {
      status: 200,
      headers,
      body: {
        authed: true,
        mode: 'github',
        label: String(principal.userDetails || principal.userId || 'github user'),
        identityProvider: 'github'
      }
    };
    return;
  }

  const session = auth.verifyAdminSession(req);
  if (session && auth.isAdminEmail(session.email)) {
    context.res = {
      status: 200,
      headers,
      body: {
        authed: true,
        mode: 'email',
        label: session.email,
        identityProvider: 'email'
      }
    };
    return;
  }

  context.res = {
    status: 200,
    headers,
    body: { authed: false }
  };
};
