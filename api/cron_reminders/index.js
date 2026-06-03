'use strict';

// Scheduled fan-out endpoint. Triggered by a GitHub Actions cron workflow
// (SWA Free Functions don't support timer triggers). Caller must present
// the X-Cron-Secret header matching the RSVP_CRON_SECRET env var.
//
// Cadence is enforced inside reminders.sendReminderToInvite (>=30 days
// between sends per invite). This endpoint runs monthly; most invites that
// have already responded or opted out get skipped immediately.

const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const reminders = require('../_lib/reminders');

module.exports = async function (context, req) {
  if (!auth.verifyCronSecret(req)) {
    context.log('cron_reminders 401 missing or bad X-Cron-Secret');
    context.res = { status: 401, body: { error: 'cron_auth_required' } };
    return;
  }

  const startedAt = new Date();
  try {
    await storage.ensureTables();
  } catch (err) {
    context.log.error(`cron_reminders ensureTables err: ${err && err.message}`);
  }

  let settings, invites;
  try {
    [settings, invites] = await Promise.all([
      storage.getSettings(),
      storage.listInvites()
    ]);
  } catch (err) {
    context.log.error(`cron_reminders load err: ${err && err.message}`);
    context.res = { status: 503, body: { error: 'storage_unavailable' } };
    return;
  }

  if (!settings.remindersEnabled) {
    context.log('cron_reminders skipped: remindersEnabled=false');
    context.res = {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: { ok: true, skipped: 'reminders_off', settings, totalInvites: invites.length }
    };
    return;
  }
  if (settings.remindersStopOnUtc) {
    const stop = new Date(settings.remindersStopOnUtc);
    if (Number.isFinite(stop.getTime()) && Date.now() > stop.getTime()) {
      context.log('cron_reminders skipped: past stop date');
      context.res = {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
        body: { ok: true, skipped: 'past_stop_date', settings, totalInvites: invites.length }
      };
      return;
    }
  }

  const dedupePhones = new Set();
  const sentRows = [];
  const skipped = {};
  let failures = 0;

  for (const invite of invites) {
    // Cheap filtering before doing any work — saves storage round-trips for
    // invites that will never be eligible.
    if (!invite.phoneNorm) { skipped.no_phone = (skipped.no_phone || 0) + 1; continue; }
    if (invite.optedOutOfSms) { skipped.opted_out = (skipped.opted_out || 0) + 1; continue; }
    if (invite.smsHardFailedAt) { skipped.hard_failed = (skipped.hard_failed || 0) + 1; continue; }
    if (invite.responded) { skipped.already_responded = (skipped.already_responded || 0) + 1; continue; }

    let result;
    try {
      result = await reminders.sendReminderToInvite(invite.inviteId, {
        context,
        force: false,
        settings,
        invite,
        dedupePhones,
        tag: 'rsvp-cron'
      });
    } catch (err) {
      failures += 1;
      context.log.error(`cron_reminders invite ${invite.inviteId} threw: ${err && err.message}`);
      continue;
    }
    if (result && result.sent) {
      sentRows.push({ inviteId: invite.inviteId, messageId: result.messageId, segmentCount: result.segmentCount });
    } else {
      const reason = (result && (result.reason || result.skipped)) || 'unknown';
      skipped[reason] = (skipped[reason] || 0) + 1;
    }
  }

  const summary = {
    ok: true,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    totalInvites: invites.length,
    sent: sentRows.length,
    sentMessages: sentRows,
    skipped,
    failures
  };
  context.log(`cron_reminders done sent=${sentRows.length} skippedReasons=${JSON.stringify(skipped)} failures=${failures}`);

  // Only log an event if we actually did something — otherwise the table
  // fills with "sent 0, skipped: already_responded:80" rows once a day for
  // months. We do log if there were failures, since those are noteworthy.
  if (sentRows.length > 0 || failures > 0) {
    try {
      const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
      await storage.appendEvent({
        type: 'cron.reminders_run',
        actor: 'cron',
        summary: `Reminders: sent ${sentRows.length}, skipped ${skippedTotal}${failures ? `, ${failures} failures` : ''}`,
        meta: { sent: sentRows.length, skipped, failures, totalInvites: invites.length }
      });
    } catch (err) {
      context.log.error(`cron_reminders event_write_failed: ${err && err.message}`);
    }
  }

  context.res = {
    status: 200,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    body: summary
  };
};
