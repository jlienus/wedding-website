'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const reminders = require('../_lib/reminders');

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
  if (!payload || typeof payload !== 'object' || typeof payload.partyId !== 'string' || !payload.partyId) {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_payload', message: 'expected { partyId: string }' } };
    return;
  }

  let result;
  try {
    result = await reminders.sendReminderToParty(payload.partyId, {
      overrideCadence: true,
      tag: 'rsvp-admin-trigger',
      type: 'reminder-admin'
    });
  } catch (err) {
    context.log.error(`admin_send_reminder err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'send_failed', message: err && err.message } };
    return;
  }
  context.log(`admin_send_reminder partyId=${payload.partyId} sent=${!!result.sent} skipped=${result.skipped || ''}`);

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, result }
  };
};
