'use strict';

// POST /api/mgmt/rsvp-cutoff
// Body: { dryRun?: boolean, confirm?: string }
//
// Admin-facing twin of cron_rsvp_cutoff. Same sweep, same safety rails, but
// gated on an admin session instead of the shared cron secret so the host can
// drive it from the admin page without touching the CLI.
//
// Two differences from the cron endpoint, both deliberate:
//
//   1. A *preview* forces past the date gate. The host should be able to see
//      the blast radius well before Nov 15, and a dry run writes nothing and
//      sends nothing, so there is nothing to protect against.
//
//   2. An *execute* never forces. Before the deadline the sweep refuses, and
//      this endpoint gives the browser no way to override that -- so no
//      sequence of clicks can auto-decline the guest list early.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const cutoff = require('../_lib/cutoff');
const notify = require('../_lib/notify');

const CONFIRM_PHRASE = 'DECLINE-OUTSTANDING';

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

  // Default-deny: only an explicit dryRun === false attempts a real sweep.
  const wantsExecute = !!(body && body.dryRun === false);
  const confirm = String((body && body.confirm) || '');

  if (wantsExecute && confirm !== CONFIRM_PHRASE) {
    context.log('admin_rsvp_cutoff 400 execute requested without the confirm phrase');
    context.res = {
      status: 400,
      headers: { ...cors, 'Cache-Control': 'no-store' },
      body: {
        error: 'confirm_required',
        message: `An execute run must also send confirm="${CONFIRM_PHRASE}". Nothing was written or sent.`
      }
    };
    return;
  }

  const actor = auth.readAdminActor(req) || 'admin:unknown';

  try {
    await storage.ensureTables();
  } catch (err) {
    context.log.error(`admin_rsvp_cutoff ensureTables err: ${err && err.message}`);
  }

  let result;
  try {
    result = await cutoff.runCutoff(context, {
      dryRun: !wantsExecute,
      // Preview early, never send early. See the header note.
      force: !wantsExecute,
      actor
    });
  } catch (err) {
    context.log.error(`admin_rsvp_cutoff run err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'cutoff_failed', detail: (err && err.message) || 'unknown' } };
    return;
  }

  if (result && result.refused) {
    context.log(`admin_rsvp_cutoff refused: ${result.refused}`);
    context.res = {
      status: 409,
      headers: { ...cors, 'Cache-Control': 'no-store' },
      body: {
        ...result,
        // Only an execute can land here -- a preview always forces past the
        // date gate -- so the message speaks to that case directly.
        message: 'The RSVP deadline has not passed yet, so nothing was written or sent. Preview is available any time; the real sweep unlocks after November 15.'
      }
    };
    return;
  }

  context.log(`admin_rsvp_cutoff actor=${actor} dryRun=${!wantsExecute} declined=${result.declined} texted=${result.texted}`);

  // Email the digest only for real runs. A preview is already on screen for
  // the admin who asked for it; mailing every click would train people to
  // ignore the one message that matters.
  if (wantsExecute) {
    try {
      await notify.emailAdminsOfCutoffSummary(context, result);
    } catch (err) {
      context.log.error(`admin_rsvp_cutoff digest_failed: ${err && err.message}`);
    }
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: result
  };
};
