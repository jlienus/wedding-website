'use strict';

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

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { payload = null; }
  if (!payload || typeof payload !== 'object' || typeof payload.enabled !== 'boolean') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_payload', message: 'expected { enabled: boolean }' } };
    return;
  }

  const now = new Date().toISOString();
  const patch = { remindersEnabled: payload.enabled };
  if (payload.enabled) {
    patch.remindersEnabledAt = now;
  } else {
    patch.remindersDisabledAt = now;
  }

  let next;
  try {
    next = await storage.setSettings(patch);
  } catch (err) {
    context.log.error(`admin_toggle_reminders err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  context.log(`admin_toggle_reminders enabled=${payload.enabled}`);

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, settings: next }
  };
};
