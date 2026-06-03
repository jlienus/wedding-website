'use strict';

// POST /api/mgmt/create-invite
// Body: { primaryFirstName, primaryLastName, phone?, locale?, adminNotes? }
// Returns: { ok: true, invite }

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const { emptyPayload } = require('../_lib/payload');

const VALID_LOCALES = new Set(['en', 'es']);

function sanitizeName(s, max = 80) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

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
  if (!body || typeof body !== 'object') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_json' } };
    return;
  }

  const primaryFirstName = sanitizeName(body.primaryFirstName);
  const primaryLastName = sanitizeName(body.primaryLastName);
  if (!primaryFirstName || !primaryLastName) {
    context.res = { status: 400, headers: cors, body: { error: 'name_required' } };
    return;
  }

  const phone = sanitizeName(body.phone, 32);
  const locale = VALID_LOCALES.has(body.locale) ? body.locale : 'en';
  const adminNotes = sanitizeName(body.adminNotes, 500);

  // Reuse the generic id generator. b64url is alphanumeric + `-_`; slice to
  // 10 chars for a friendly-ish length and prepend `i_`.
  const inviteId = `i_${auth.generateId().slice(0, 10)}`;

  const invite = {
    inviteId,
    primaryFirstName,
    primaryLastName,
    phone,
    locale,
    adminNotes,
    payload: emptyPayload(),
    responded: false,
    respondedAt: '',
    respondedLate: false,
    optedOutOfSms: false,
    smsHardFailedAt: '',
    lastReminderSentAt: '',
    reminderCount: 0
  };

  try {
    await storage.upsertInvite(invite);
  } catch (err) {
    context.log.error(`admin_create_invite err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  const created = await storage.getInvite(inviteId);
  context.log(`admin_create_invite inviteId=${inviteId} name="${primaryFirstName} ${primaryLastName}"`);

  try {
    const principal = auth.readAdminPrincipal(req) || {};
    await storage.appendEvent({
      type: 'admin.invite_created',
      actor: `admin:${String(principal.userDetails || 'unknown').toLowerCase()}`,
      summary: `Invite created for ${primaryFirstName} ${primaryLastName}`,
      meta: { inviteId, primaryFirstName, primaryLastName, locale, hasPhone: !!phone }
    });
  } catch (err) {
    context.log.error(`admin_create_invite event_write_failed: ${err && err.message}`);
  }

  context.res = {
    status: 201,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, invite: created }
  };
};
