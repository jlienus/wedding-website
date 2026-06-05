'use strict';

// POST /api/mgmt/admin-logout
// Clears the admin_session cookie. Idempotent: returns 200 even if the
// caller wasn't signed in (we don't want a "you're already logged out"
// error UX).
//
// Only affects the email-auth path. For GitHub-auth, the SWA built-in
// /.auth/logout endpoint is what clears the underlying provider session;
// the admin UI exposes both options separately.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

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

  // Look up the session to get the email for the audit log BEFORE clearing.
  const session = auth.verifyAdminSession(req);

  try {
    await storage.appendEvent({
      type: 'admin.logout',
      actor: session ? `email:${session.email}` : 'anonymous',
      summary: session ? 'Admin signed out' : 'Logout called without session',
      meta: {}
    });
  } catch (err) { context.log.error(`admin_logout event_write: ${err && err.message}`); }

  context.res = {
    status: 200,
    headers: {
      ...cors,
      'Set-Cookie': auth.clearAdminSessionCookie(),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: { ok: true }
  };
};
