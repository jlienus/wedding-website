'use strict';

// POST /api/internal/event — secret-protected event-write endpoint used by
// GitHub Actions workflows to log deployment and backup outcomes into the
// admin Recent-activity feed.
//
// Auth: `X-Internal-Secret` header (RSVP_INTERNAL_SECRET, distinct from the
// reminders cron secret and the backup secret so a leak of any one has a
// narrow blast radius).
//
// Type allowlist is intentionally exact (not a prefix). Anything not in the
// allowlist is rejected — this prevents a leaked secret from being used to
// forge `rsvp.submitted` events or to spam arbitrary types into the table.

const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

const ALLOWED_TYPES = new Set([
  'deploy.succeeded',
  'deploy.failed',
  'backup.completed',
  'backup.failed'
]);

const MAX_BODY_BYTES = 8 * 1024;
const ACTOR_MAX = 128;
const SUMMARY_MAX = 500;

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 204 };
    return;
  }
  if (req.method !== 'POST') {
    context.res = { status: 405, body: { error: 'method_not_allowed' } };
    return;
  }
  if (req.rawBody && typeof req.rawBody === 'string' && req.rawBody.length > MAX_BODY_BYTES) {
    context.res = { status: 413, body: { error: 'payload_too_large' } };
    return;
  }
  if (!auth.verifyInternalSecret(req)) {
    context.res = { status: 401, body: { error: 'unauthorized' } };
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { body = null; }
  if (!body || typeof body !== 'object') {
    context.res = { status: 400, body: { error: 'invalid_json' } };
    return;
  }

  const type = typeof body.type === 'string' ? body.type : '';
  if (!ALLOWED_TYPES.has(type)) {
    context.res = { status: 400, body: { error: 'type_not_allowed', allowed: Array.from(ALLOWED_TYPES) } };
    return;
  }
  const actor = typeof body.actor === 'string' ? body.actor.slice(0, ACTOR_MAX) : '';
  const summary = typeof body.summary === 'string' ? body.summary.slice(0, SUMMARY_MAX) : '';
  const meta = (body.meta && typeof body.meta === 'object') ? body.meta : null;

  try {
    const rowKey = await storage.appendEvent({ type, actor, summary, meta });
    context.log(`internal_event ok type=${type} rowKey=${rowKey}`);
    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { ok: true, rowKey }
    };
  } catch (err) {
    context.log.error(`internal_event write err: ${err && err.message}`);
    context.res = { status: 503, body: { error: 'storage_unavailable' } };
  }
};
