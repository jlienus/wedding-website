'use strict';

// Admin patch endpoint for a party record. Allowlisted fields only — no
// blind merge of caller-supplied JSON onto storage entities.
//
// Common uses:
//   - Update a wrong phone number               { phone: "+15551234567" }
//   - Clear an accidental opt-out                { optedOutOfSms: false }
//   - Clear a hard-failure flag after fixing #   { smsHardFailedAt: "" }
//   - Toggle plus-one allowance                  { plusOneAllowed: true }

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

const PATCHABLE_STRING = new Set(['displayName', 'phone', 'group', 'notes', 'locale', 'smsHardFailedAt']);
const PATCHABLE_BOOL = new Set(['plusOneAllowed', 'kidsAllowed', 'optedOutOfSms']);

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
    context.res = { status: 400, headers: cors, body: { error: 'invalid_payload', message: 'expected { partyId, patch }' } };
    return;
  }
  if (!payload.patch || typeof payload.patch !== 'object') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_payload', message: 'patch must be an object' } };
    return;
  }

  const existing = await storage.getParty(payload.partyId);
  if (!existing) {
    context.res = { status: 404, headers: cors, body: { error: 'party_not_found' } };
    return;
  }

  const patch = {};
  const rejected = [];
  for (const [k, v] of Object.entries(payload.patch)) {
    if (PATCHABLE_STRING.has(k)) {
      patch[k] = typeof v === 'string' ? v : '';
    } else if (PATCHABLE_BOOL.has(k)) {
      patch[k] = !!v;
    } else {
      rejected.push(k);
    }
  }
  if (Object.keys(patch).length === 0) {
    context.res = { status: 400, headers: cors, body: { error: 'no_patchable_fields', rejected } };
    return;
  }

  // Renormalize phone if changed
  if ('phone' in patch) {
    patch.phoneNorm = storage.normalizePhone(patch.phone);
  }

  try {
    await storage.patchParty(payload.partyId, patch);
  } catch (err) {
    context.log.error(`admin_update_party err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  const after = await storage.getParty(payload.partyId);
  context.log(`admin_update_party partyId=${payload.partyId} fields=${Object.keys(patch).join(',')}`);

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, party: after, rejected: rejected.length ? rejected : undefined }
  };
};
