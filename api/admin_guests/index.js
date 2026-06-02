'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

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

  let parties, settings;
  try {
    [parties, settings] = await Promise.all([
      storage.listParties(),
      storage.getSettings()
    ]);
  } catch (err) {
    context.log.error(`admin_guests load err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  parties.sort((a, b) => (a.displayName || a.partyId).localeCompare(b.displayName || b.partyId));

  // Load members + responses + recent SMS for every party in parallel. Each
  // party = 3 storage calls; we let them all race rather than walking the
  // list sequentially. For ~150 parties this finishes in ~2s instead of
  // ~30s.
  const partyBundles = await Promise.all(parties.map(async (party) => {
    try {
      const [members, responses, smsLog] = await Promise.all([
        storage.listMembers(party.partyId),
        storage.getResponses(party.partyId),
        storage.listSmsLog(party.partyId, 5)
      ]);
      return { party, members, responses, smsLog, loadError: null };
    } catch (err) {
      context.log.error(`admin_guests party ${party.partyId} load err: ${err && err.message}`);
      return { party, members: [], responses: [], smsLog: [], loadError: (err && err.message) || 'unknown' };
    }
  }));

  const rows = [];
  for (const bundle of partyBundles) {
    const { party, members, responses, smsLog } = bundle;
    const responseByMember = new Map(responses.map((r) => [r.memberId, r]));
    members.sort((a, b) => {
      const order = { primary: 0, plusone: 1, child: 2, guest: 1 };
      const oa = order[a.role] ?? 9;
      const ob = order[b.role] ?? 9;
      if (oa !== ob) return oa - ob;
      return (a.firstName || '').localeCompare(b.firstName || '');
    });
    const memberSummaries = members.map((m) => {
      const r = responseByMember.get(m.memberId) || null;
      return {
        memberId: m.memberId,
        firstName: m.firstName,
        lastName: m.lastName,
        role: m.role,
        isKid: m.isKid,
        attending: r ? r.attending : null,
        mealChoice: r ? r.mealChoice : '',
        dietary: r ? r.dietary : '',
        songRequest: r ? r.songRequest : '',
        plusOneName: r ? r.plusOneName : '',
        notes: r ? r.notes : '',
        submittedAt: r ? r.submittedAt : '',
        updatedAt: r ? r.updatedAt : '',
        submittedByMethod: r ? r.submittedByMethod : ''
      };
    });
    const responseCount = memberSummaries.filter((m) => m.attending !== null).length;
    const attendingCount = memberSummaries.filter((m) => m.attending === true).length;
    rows.push({
      party,
      members: memberSummaries,
      stats: {
        memberCount: members.length,
        responseCount,
        attendingCount,
        fullyResponded: responseCount === members.length && members.length > 0
      },
      recentSms: smsLog.map((s) => ({
        type: s.type,
        deliveryStatus: s.deliveryStatus,
        errorCode: s.errorCode,
        bodyLen: s.bodyLen,
        sentAt: s.sentAt,
        toPhone: s.toPhone,
        correlationId: s.correlationId
      })),
      loadError: bundle.loadError || undefined
    });
  }

  const overall = {
    partyCount: rows.length,
    fullyRespondedParties: rows.filter((r) => r.stats.fullyResponded).length,
    totalGuests: rows.reduce((n, r) => n + r.stats.memberCount, 0),
    confirmedAttending: rows.reduce((n, r) => n + r.stats.attendingCount, 0),
    confirmedNotAttending: rows.reduce((n, r) => n + r.members.filter((m) => m.attending === false).length, 0),
    optedOutCount: rows.filter((r) => r.party.optedOutOfSms).length,
    hardFailedCount: rows.filter((r) => r.party.smsHardFailedAt).length
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
