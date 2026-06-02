'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const { summarize } = require('../_lib/payload');

// GET /api/mgmt/guests — admin dashboard payload. Returns settings, every
// invite (full), per-invite SMS log (last 5), and overall stats.
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
  if (!auth.isAdmin(req)) {
    context.res = { status: 403, headers: cors, body: { error: 'admin_required' } };
    return;
  }

  let invites, settings;
  try {
    [invites, settings] = await Promise.all([
      storage.listInvites(),
      storage.getSettings()
    ]);
  } catch (err) {
    context.log.error(`admin_guests load err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  invites.sort((a, b) => {
    const an = `${a.primaryLastName} ${a.primaryFirstName}`.trim().toLowerCase();
    const bn = `${b.primaryLastName} ${b.primaryFirstName}`.trim().toLowerCase();
    return an.localeCompare(bn);
  });

  // Load SMS log per invite in parallel — cheap at our scale.
  const rows = await Promise.all(invites.map(async (invite) => {
    let smsLog = [];
    try {
      smsLog = await storage.listSmsLog(invite.inviteId, 5);
    } catch (err) {
      context.log.error(`admin_guests sms ${invite.inviteId} err: ${err && err.message}`);
    }
    const summary = summarize(invite.payload);
    return {
      invite, // includes full payload for the drill-down
      summary,
      recentSms: smsLog.map((s) => ({
        type: s.type,
        deliveryStatus: s.deliveryStatus,
        errorCode: s.errorCode,
        bodyLen: s.bodyLen,
        sentAt: s.sentAt,
        toPhone: s.toPhone,
        correlationId: s.correlationId
      }))
    };
  }));

  const overall = {
    inviteCount: rows.length,
    respondedCount: rows.filter((r) => r.invite.responded).length,
    pendingCount: rows.filter((r) => !r.invite.responded).length,
    totalYes: rows.reduce((n, r) => n + r.summary.yes, 0),
    totalNo: rows.reduce((n, r) => n + r.summary.no, 0),
    totalPending: rows.reduce((n, r) => n + r.summary.pending, 0),
    totalAdults: rows.reduce((n, r) => n + r.summary.adults, 0),
    totalKids: rows.reduce((n, r) => n + r.summary.kids, 0),
    withPhone: rows.filter((r) => r.invite.phoneNorm).length,
    optedOutCount: rows.filter((r) => r.invite.optedOutOfSms).length,
    hardFailedCount: rows.filter((r) => r.invite.smsHardFailedAt).length
  };

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: {
      ok: true,
      settings,
      overall,
      rows,
      generatedAt: new Date().toISOString()
    }
  };
};
