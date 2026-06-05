'use strict';

// POST /api/mgmt/update-invite
//
// Body: { inviteId: string, patch: { ...allowlisted fields } }
//
// Allowlisted top-level invite fields: primaryFirstName, primaryLastName,
// phone, locale, adminNotes, optedOutOfSms, smsHardFailedAt, lastReminderSentAt.
//
// If `patch.payload` is included it MUST be a valid payload object (we run it
// through the same validator the public submit uses). The admin can store an
// incomplete payload (attending: null) — only `requireAttending` is relaxed
// for admin edits.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const { validatePayload, isComplete } = require('../_lib/payload');

const PATCHABLE_STRING = new Set([
  'primaryFirstName', 'primaryLastName', 'phone', 'locale',
  'adminNotes', 'smsHardFailedAt', 'lastReminderSentAt', 'respondedAt'
]);
const PATCHABLE_BOOL = new Set([
  'optedOutOfSms', 'responded', 'respondedLate'
]);
const PATCHABLE_INT = new Set(['reminderCount']);

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
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { body = null; }
  if (!body || typeof body !== 'object' || typeof body.inviteId !== 'string' || !body.inviteId) {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_payload', message: 'expected { inviteId, patch }' } };
    return;
  }
  if (!body.patch || typeof body.patch !== 'object') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_payload', message: 'patch must be an object' } };
    return;
  }

  const existing = await storage.getInvite(body.inviteId);
  if (!existing) {
    context.res = { status: 404, headers: cors, body: { error: 'invite_not_found' } };
    return;
  }

  const patch = {};
  const rejected = [];
  for (const [k, v] of Object.entries(body.patch)) {
    if (PATCHABLE_STRING.has(k)) {
      patch[k] = typeof v === 'string' ? v : '';
    } else if (PATCHABLE_BOOL.has(k)) {
      patch[k] = !!v;
    } else if (PATCHABLE_INT.has(k)) {
      patch[k] = Number.isFinite(Number(v)) ? Number(v) : 0;
    } else if (k === 'payload') {
      // Run admin-supplied payloads through the same validator the public
      // submit uses. The only relaxation: admin may save an incomplete state.
      if (v === null) {
        patch.payload = '';
      } else {
        const validated = validatePayload(v, { requireAttending: false });
        if (!validated.ok) {
          context.res = { status: 400, headers: cors, body: { error: 'invalid_payload_field', field: 'payload', detail: validated.error } };
          return;
        }
        patch.payload = validated.json;
        // Recompute responded/respondedAt from completion of the new payload
        // unless the admin also passed an explicit responded value.
        if (!('responded' in body.patch)) {
          patch.responded = isComplete(validated.payload);
          if (patch.responded && !existing.respondedAt && !('respondedAt' in body.patch)) {
            patch.respondedAt = new Date().toISOString();
          }
        }
      }
    } else {
      rejected.push(k);
    }
  }
  if (Object.keys(patch).length === 0) {
    context.res = { status: 400, headers: cors, body: { error: 'no_patchable_fields', rejected } };
    return;
  }

  try {
    await storage.patchInvite(body.inviteId, patch);
  } catch (err) {
    context.log.error(`admin_update_invite err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  const after = await storage.getInvite(body.inviteId);
  context.log(`admin_update_invite inviteId=${body.inviteId} fields=${Object.keys(patch).join(',')}`);

  try {
    const principal = auth.readAdminPrincipal(req) || {};
    const meta = { inviteId: body.inviteId, fields: Object.keys(patch), rejected: rejected.length ? rejected : undefined };
    // When a payload edit is part of this patch, snapshot the pre-edit payload
    // into the audit log so an accidental destructive change (wiped meal picks,
    // dropped guest, attending flipped to no) can be reversed by hand.
    //
    // storage.appendEvent caps the stringified `meta` at EVENT_META_MAX (4096
    // chars). Cap snapshots well under that (3000 chars JSON) so the other
    // meta fields fit and the result stays valid JSON on read-back. A typical
    // 1-primary + 2-guest RSVP serializes to ~1500-2500 chars, so this fits
    // every realistic invite. The few hypothetical edge cases (12+ guests
    // with long dietary text) record a truncation marker instead of garbage.
    if ('payload' in patch) {
      try {
        const prior = existing.payload || null;
        const priorJson = prior ? JSON.stringify(prior) : null;
        if (priorJson && priorJson.length <= 3000) {
          meta.payloadBefore = prior;
        } else if (priorJson) {
          meta.payloadBeforeTruncated = true;
          meta.payloadBeforeSize = priorJson.length;
        }
      } catch { /* ignore — audit log is best-effort */ }
    }
    await storage.appendEvent({
      type: 'admin.invite_updated',
      actor: `admin:${String(principal.userDetails || 'unknown').toLowerCase()}`,
      summary: `Updated invite for ${existing.primaryFirstName} ${existing.primaryLastName}: ${Object.keys(patch).join(', ')}`,
      meta
    });
  } catch (err) {
    context.log.error(`admin_update_invite event_write_failed: ${err && err.message}`);
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, invite: after, rejected: rejected.length ? rejected : undefined }
  };
};
