'use strict';

// Post-deadline RSVP cutoff endpoint. Triggered by the "RSVP Cutoff" GitHub
// Actions workflow (manual dispatch only -- see .github/workflows/rsvp-cutoff.yml).
// Caller must present X-Cron-Secret matching RSVP_CRON_SECRET, same as
// cron_reminders.
//
// This is the one endpoint in the app that can text the entire guest list in a
// single call, so it is deliberately hostile to being fired by accident:
//
//   1. dryRun defaults to TRUE. Omitting the flag previews; it never sends.
//   2. An execute run additionally requires confirm === 'DECLINE-OUTSTANDING'.
//      Two independent mistakes are needed to reach a real send.
//   3. It refuses to run at all before RSVP_GUEST_DEADLINE_UTC unless force is
//      also set, so an early dispatch can't jump the gun on the deadline.
//
// The sweep itself is idempotent (see _lib/cutoff.js), so re-running after a
// partial failure is safe and cannot double-text anyone.

const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const cutoff = require('../_lib/cutoff');
const notify = require('../_lib/notify');

const CONFIRM_PHRASE = 'DECLINE-OUTSTANDING';

function readFlag(req, name) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  if (body[name] !== undefined) return body[name];
  const query = (req && req.query) || {};
  return query[name];
}

function isTruthy(v) {
  if (v === true) return true;
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

module.exports = async function (context, req) {
  if (!auth.verifyCronSecret(req)) {
    context.log('cron_rsvp_cutoff 401 missing or bad X-Cron-Secret');
    context.res = { status: 401, body: { error: 'cron_auth_required' } };
    return;
  }

  // Default-deny: only an explicit dryRun=false even attempts a real sweep.
  const dryRunRaw = readFlag(req, 'dryRun');
  const wantsExecute = dryRunRaw !== undefined && !isTruthy(dryRunRaw);
  const confirm = String(readFlag(req, 'confirm') || '');
  const force = isTruthy(readFlag(req, 'force'));

  if (wantsExecute && confirm !== CONFIRM_PHRASE) {
    context.log('cron_rsvp_cutoff 400 execute requested without the confirm phrase');
    context.res = {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
      body: {
        error: 'confirm_required',
        message: `An execute run must also send confirm="${CONFIRM_PHRASE}". Nothing was written or sent.`
      }
    };
    return;
  }

  try {
    await storage.ensureTables();
  } catch (err) {
    context.log.error(`cron_rsvp_cutoff ensureTables err: ${err && err.message}`);
  }

  let result;
  try {
    result = await cutoff.runCutoff(context, { dryRun: !wantsExecute, force });
  } catch (err) {
    context.log.error(`cron_rsvp_cutoff run err: ${err && err.message}`);
    context.res = { status: 503, body: { error: 'cutoff_failed', detail: (err && err.message) || 'unknown' } };
    return;
  }

  if (result && result.refused) {
    context.log(`cron_rsvp_cutoff refused: ${result.refused}`);
    context.res = {
      status: 409,
      headers: { 'Cache-Control': 'no-store' },
      body: {
        ...result,
        message: 'The guest deadline has not passed yet. Pass force=true to override in a test environment.'
      }
    };
    return;
  }

  // Best-effort digest; a mail failure must not make a completed sweep look
  // like it failed, so this never throws to the caller.
  try {
    await notify.emailAdminsOfCutoffSummary(context, result);
  } catch (err) {
    context.log.error(`cron_rsvp_cutoff notify err: ${err && err.message}`);
  }

  context.res = {
    status: 200,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    body: result
  };
};
