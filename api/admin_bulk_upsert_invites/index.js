'use strict';

// POST /api/mgmt/bulk-upsert-invites
//
// Body: {
//   dryRun?: boolean,                      // default false — when true, no writes
//   rows: Array<{
//     primaryFirstName: string,            // required
//     primaryLastName:  string,            // required
//     phone?:           string,            // optional — blank = no change on existing rows
//     locale?:          'en' | 'es'        // optional — blank = no change on existing rows
//   }>
// }
//
// Returns: {
//   ok: true,
//   dryRun: boolean,
//   summary: { created: N, updated: N, skipped: N, errors: N },
//   results: Array<{
//     row: number,                         // 1-based, matches client preview row index
//     primaryFirstName, primaryLastName, phone, locale,
//     action: 'create' | 'update' | 'skip' | 'error',
//     inviteId?: string,                   // for matched/created rows
//     existingResponded?: boolean,         // for update rows — flag that the existing
//                                          // RSVP response is being preserved
//     reason?: string                      // for skip/error
//   }>
// }
//
// MATCH KEY: (primaryFirstName, primaryLastName), case-insensitive via normalizeName.
//
// Why name-only (not phone): two real people can legitimately share a phone (parents and
// kids on a family line), but two distinct rows in our invite table almost never share
// first+last by coincidence. When ambiguity does happen we report 'skip: ambiguous' so
// the admin can resolve manually rather than risk patching the wrong row.
//
// RSVP PRESERVATION:
// - On no-match → upsertInvite creates a fresh row with emptyPayload(), responded=false.
// - On single-match → patchInvite does a Table-Storage Merge: ONLY the fields we put in
//   the patch are written. We deliberately put ONLY phone/locale (and only when the CSV
//   actually provided them), so payload, responded, respondedAt, adminNotes,
//   optedOutOfSms, etc. are untouched. Blank CSV phone = no patch on phone.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const { emptyPayload } = require('../_lib/payload');

const VALID_LOCALES = new Set(['en', 'es']);
// Soft cap on rows per request. 500 rows ≈ ~1,000 Table calls (one name lookup + one
// write per row). At ~50 ms each that's ~50s — well under the Functions consumption
// 5-min limit but tight enough we don't want callers shoving the entire universe in.
// The wedding guest list is bounded by physics; this is a sanity cap.
const MAX_ROWS = 500;

function sanitizeName(s, max = 80) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

function pickLocale(v) {
  if (typeof v !== 'string') return '';
  const lower = v.trim().toLowerCase();
  return VALID_LOCALES.has(lower) ? lower : '';
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
  if (!Array.isArray(body.rows)) {
    context.res = { status: 400, headers: cors, body: { error: 'rows_required', message: 'expected { rows: [...] }' } };
    return;
  }
  if (body.rows.length === 0) {
    context.res = { status: 400, headers: cors, body: { error: 'rows_empty' } };
    return;
  }
  if (body.rows.length > MAX_ROWS) {
    context.res = {
      status: 400,
      headers: cors,
      body: { error: 'too_many_rows', message: `max ${MAX_ROWS} rows per request, got ${body.rows.length}` }
    };
    return;
  }

  const dryRun = body.dryRun === true;
  const results = [];
  const summary = { created: 0, updated: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < body.rows.length; i++) {
    const raw = body.rows[i] || {};
    const rowNum = i + 1;
    const primaryFirstName = sanitizeName(raw.primaryFirstName);
    const primaryLastName = sanitizeName(raw.primaryLastName);
    const phone = sanitizeName(raw.phone, 32);
    const locale = pickLocale(raw.locale);

    const base = { row: rowNum, primaryFirstName, primaryLastName, phone, locale };

    if (!primaryFirstName || !primaryLastName) {
      results.push({ ...base, action: 'error', reason: 'first and last name required' });
      summary.errors++;
      continue;
    }

    let match;
    try {
      match = await storage.findInviteByPrimaryName(primaryFirstName, primaryLastName);
    } catch (err) {
      context.log.error(`bulk_upsert lookup_failed row=${rowNum} err=${err && err.message}`);
      results.push({ ...base, action: 'error', reason: `lookup failed: ${err && err.message || 'unknown'}` });
      summary.errors++;
      continue;
    }

    if (match && match.ambiguous) {
      results.push({
        ...base,
        action: 'skip',
        reason: `ambiguous: ${match.matchCount} existing invitations share this name — resolve manually`
      });
      summary.skipped++;
      continue;
    }

    if (match && match.inviteId) {
      // UPDATE path. Build a minimal patch with only fields the CSV explicitly
      // supplied — empty cells mean "no change", not "clear it".
      const patch = {};
      if (phone) patch.phone = phone;
      if (locale) patch.locale = locale;

      let existingResponded = false;
      try {
        const existing = await storage.getInvite(match.inviteId);
        existingResponded = !!(existing && existing.responded);
      } catch {
        // Best-effort flag. If the lookup races / fails we still proceed with the patch
        // — the patch itself doesn't touch the payload field.
      }

      if (Object.keys(patch).length === 0) {
        results.push({
          ...base,
          action: 'skip',
          inviteId: match.inviteId,
          existingResponded,
          reason: 'name matches existing invite and CSV has no phone/locale to update'
        });
        summary.skipped++;
        continue;
      }

      if (!dryRun) {
        try {
          await storage.patchInvite(match.inviteId, patch);
        } catch (err) {
          context.log.error(`bulk_upsert patch_failed row=${rowNum} inviteId=${match.inviteId} err=${err && err.message}`);
          results.push({ ...base, action: 'error', inviteId: match.inviteId, reason: `update failed: ${err && err.message || 'unknown'}` });
          summary.errors++;
          continue;
        }
      }

      results.push({
        ...base,
        action: 'update',
        inviteId: match.inviteId,
        existingResponded
      });
      summary.updated++;
      continue;
    }

    // CREATE path. Mirrors admin_create_invite/index.js so the invite shape stays
    // consistent across creation channels (manual form + bulk import).
    const inviteId = `i_${auth.generateId().slice(0, 10)}`;
    const invite = {
      inviteId,
      primaryFirstName,
      primaryLastName,
      phone,
      locale: locale || 'en',
      adminNotes: '',
      payload: emptyPayload(),
      responded: false,
      respondedAt: '',
      respondedLate: false,
      optedOutOfSms: false,
      smsHardFailedAt: '',
      lastReminderSentAt: '',
      reminderCount: 0
    };

    if (!dryRun) {
      try {
        await storage.upsertInvite(invite);
      } catch (err) {
        context.log.error(`bulk_upsert create_failed row=${rowNum} err=${err && err.message}`);
        results.push({ ...base, action: 'error', reason: `create failed: ${err && err.message || 'unknown'}` });
        summary.errors++;
        continue;
      }
    }

    results.push({ ...base, action: 'create', inviteId });
    summary.created++;
  }

  if (!dryRun) {
    try {
      const principal = auth.readAdminPrincipal(req) || {};
      await storage.appendEvent({
        type: 'admin.bulk_upsert',
        actor: `admin:${String(principal.userDetails || 'unknown').toLowerCase()}`,
        summary: `Bulk import: ${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.errors} errors (${body.rows.length} rows)`,
        meta: { ...summary, totalRows: body.rows.length }
      });
    } catch (err) {
      context.log.error(`bulk_upsert event_write_failed: ${err && err.message}`);
    }
  }

  context.log(`admin_bulk_upsert dryRun=${dryRun} rows=${body.rows.length} created=${summary.created} updated=${summary.updated} skipped=${summary.skipped} errors=${summary.errors}`);

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, dryRun, summary, results }
  };
};
