'use strict';

// Scheduled fan-out endpoint. Triggered by a GitHub Actions cron workflow
// (SWA Free Functions don't support timer triggers). Caller must present
// the X-Cron-Secret header matching the RSVP_CRON_SECRET env var.
//
// Cadence is enforced inside reminders.sendReminderToParty (>=30 days
// between sends per party). This endpoint runs daily; most parties will
// be skipped most days.

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
    // Idempotent — creates tables on first run, no-op afterwards.
    await storage.ensureTables();
  } catch (err) {
    context.log.error(`cron_reminders ensureTables err: ${err && err.message}`);
  }

  let settings, parties;
  try {
    [settings, parties] = await Promise.all([
      storage.getSettings(),
      storage.listParties()
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
      body: { ok: true, skipped: 'reminders_off', settings, totalParties: parties.length }
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
        body: { ok: true, skipped: 'past_stop_date', settings, totalParties: parties.length }
      };
      return;
    }
  }

  const dedupePhones = new Set();
  const sentRows = [];
  const skipped = {};
  let failures = 0;

  for (const party of parties) {
    let result;
    try {
      result = await reminders.sendReminderToParty(party.partyId, {
        overrideCadence: false,
        settings,
        dedupePhones,
        tag: 'rsvp-cron'
      });
    } catch (err) {
      failures += 1;
      context.log.error(`cron_reminders party ${party.partyId} threw: ${err && err.message}`);
      continue;
    }
    if (result.sent) {
      sentRows.push({ partyId: party.partyId, messageId: result.messageId, segmentCount: result.segmentCount });
    } else {
      const reason = result.skipped || 'unknown';
      skipped[reason] = (skipped[reason] || 0) + 1;
    }
  }

  const summary = {
    ok: true,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    totalParties: parties.length,
    sent: sentRows.length,
    sentMessages: sentRows,
    skipped,
    failures
  };
  context.log(`cron_reminders done sent=${sentRows.length} skippedReasons=${JSON.stringify(skipped)} failures=${failures}`);

  context.res = {
    status: 200,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    body: summary
  };
};
