'use strict';

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

// GET /api/mgmt/events — admin "Recent activity" feed. Returns newest-first.
// Auth: same SWA-principal admin gate as /api/mgmt/guests.
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

  let limit = DEFAULT_LIMIT;
  const rawLimit = req.query && (req.query.limit || req.query.Limit);
  if (rawLimit != null) {
    const n = Number(rawLimit);
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), MAX_LIMIT);
  }

  let events;
  try {
    events = await storage.listEvents(limit);
  } catch (err) {
    context.log.error(`admin_events load err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'storage_unavailable' } };
    return;
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: { ok: true, events, generatedAt: new Date().toISOString() }
  };
};
