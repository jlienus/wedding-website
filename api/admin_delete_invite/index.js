'use strict';

// POST /api/mgmt/delete-invite
// Body: { inviteId: string }
// Returns: { ok: true, deleted: true, smsRowsDeleted: N }

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
  if (!auth.isAdmin(req)) {
    context.res = { status: 403, headers: cors, body: { error: 'admin_required' } };
    return;
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { body = null; }
  const inviteId = body && typeof body.inviteId === 'string' ? body.inviteId : '';
  if (!inviteId) {
    context.res = { status: 400, headers: cors, body: { error: 'inviteId_required' } };
    return;
  }

  const existing = await storage.getInvite(inviteId);
  if (!existing) {
    context.res = { status: 404, headers: cors, body: { error: 'invite_not_found' } };
    return;
  }

  let result;
  try {
    result = await storage.deleteInvite(inviteId);
  } catch (err) {
    context.log.error(`admin_delete_invite err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  context.log(`admin_delete_invite inviteId=${inviteId} smsRowsDeleted=${result && result.smsRowsDeleted}`);

  try {
    const principal = auth.readAdminPrincipal(req) || {};
    await storage.appendEvent({
      type: 'admin.invite_deleted',
      actor: `admin:${String(principal.userDetails || 'unknown').toLowerCase()}`,
      summary: `Deleted invite for ${existing.primaryFirstName} ${existing.primaryLastName}`,
      meta: { inviteId, smsRowsDeleted: (result && result.smsRowsDeleted) || 0 }
    });
  } catch (err) {
    context.log.error(`admin_delete_invite event_write_failed: ${err && err.message}`);
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, deleted: true, smsRowsDeleted: (result && result.smsRowsDeleted) || 0 }
  };
};
