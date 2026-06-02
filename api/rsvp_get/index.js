'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

// GET /api/rsvp/get — reads the session cookie and returns the party + members
// + existing responses. Used by the form on return visits and after magic-link
// redirect. No body needed.
module.exports = async function (context, req) {
  const pre = preflight(req, 'GET, OPTIONS');
  if (pre.handled) { context.res = pre.response; return; }
  const { cors, origin } = pre;

  if (req.method !== 'GET') {
    context.res = { status: 405, headers: cors, body: { error: 'Method not allowed' } };
    return;
  }
  if (origin && !isAllowedOrigin(origin)) {
    context.res = { status: 403, headers: cors, body: { error: 'Origin not allowed' } };
    return;
  }

  let session;
  try {
    session = auth.verifySessionCookie(req);
  } catch (err) {
    context.log.error(`rsvp_get cookie err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'config_error' } };
    return;
  }
  if (!session) {
    context.res = {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { authenticated: false }
    };
    return;
  }

  const { partyId } = session;

  let party, members, responses;
  try {
    [party, members, responses] = await Promise.all([
      storage.getParty(partyId),
      storage.listMembers(partyId),
      storage.getResponses(partyId)
    ]);
  } catch (err) {
    context.log.error(`rsvp_get storage err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }
  if (!party) {
    // Cookie pointed to a deleted party. Clear cookie.
    context.res = {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Set-Cookie': auth.clearSessionCookie() },
      body: { authenticated: false, reason: 'party_not_found' }
    };
    return;
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: {
      authenticated: true,
      party: {
        partyId: party.partyId,
        displayName: party.displayName,
        locale: party.locale,
        plusOneAllowed: party.plusOneAllowed,
        kidsAllowed: party.kidsAllowed,
        hasPhone: !!party.phoneNorm
      },
      members: members.map((m) => ({ memberId: m.memberId, firstName: m.firstName, lastName: m.lastName, role: m.role, isKid: m.isKid })),
      responses: responses.map((r) => ({
        memberId: r.memberId,
        attending: r.attending,
        mealChoice: r.mealChoice,
        dietary: r.dietary,
        songRequest: r.songRequest,
        notes: r.notes,
        plusOneName: r.plusOneName,
        submittedAt: r.submittedAt,
        updatedAt: r.updatedAt
      }))
    }
  };
};
