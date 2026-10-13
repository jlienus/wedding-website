'use strict';

// Post-deadline RSVP cutoff sweep.
//
// Once RSVP_GUEST_DEADLINE_UTC (Nov 15) passes, every household that never
// finished its RSVP is recorded as "not attending" so the headcount handed to
// the venue is a real number instead of a pile of unanswered nulls. Each one
// then gets a single text saying so, with a magic link to change it.
//
// Properties that matter, and why:
//
//   * Idempotent. The sweep only selects invites where responded === false,
//     and declining one flips responded -> true. A second run therefore finds
//     nothing left to do and physically cannot double-text. Safe to re-run
//     after a partial failure, which is the whole reason the write happens
//     before the send (see runCutoff).
//
//   * Non-destructive. Only *unanswered* attendees flip to false. An explicit
//     yes or no already sitting in the payload is the guest's own answer and
//     survives untouched.
//
//   * Households with someone already attending are never swept. Blanket-
//     texting "you are marked as not attending" to a household where someone
//     said yes would be flatly wrong, so those are bucketed as needs_review
//     for the host to finish by hand.
//
//   * Opted-out and hard-failed numbers are still recorded as declined -- the
//     headcount has to be right regardless -- but are never texted.
//
//   * Reminders stop on their own. reminders.sendReminderToInvite skips any
//     invite with responded === true (rule 6 in its decision matrix), so once
//     the sweep completes the monthly cron has nothing left to send. That is
//     why this feature ships no "disable texting" kill switch: the sweep is
//     the off switch, and leaving the plumbing enabled keeps guest-initiated
//     login codes working so people can still change their answer.

const storage = require('./storage');
const sms = require('./sms');
const auth = require('./auth');
const payloadLib = require('./payload');
const reminders = require('./reminders');

const SITE_ORIGIN = (process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com').replace(/\/$/, '');

// The moment outstanding RSVPs become sweepable. Shared with rsvp_submit,
// which uses the same env var to flag late submissions, so the two can never
// disagree about when the deadline was.
const GUEST_DEADLINE_UTC = new Date(process.env.RSVP_GUEST_DEADLINE_UTC || '2026-11-15T23:59:59-05:00');

// The hard close on all submissions, from rsvp_submit. Quoted to guests in the
// auto-decline text as the real "you can still change it until" date -- saying
// "anytime" would be a promise the API stops keeping on Jan 15.
const PERMANENT_LOCK_UTC = new Date(process.env.RSVP_PERMANENT_LOCK_UTC || '2027-01-15T23:59:59-05:00');

// Display strings, not derived from the dates above on purpose: these have to
// match the printed invitation cards exactly, and a locale-formatted date
// would drift from them the moment either constant is nudged. Same convention
// as reminders.deadlineDisplay.
function updateUntilDisplay(locale) {
  return locale === 'es' ? '15 de enero' : 'January 15';
}

// Keep the readable copy for audit logs and admin previews but strip the magic
// token, so a log leak -- or a browser devtools window left open on the admin
// page -- can't be replayed into someone else's RSVP.
function redactToken(body) {
  return String(body == null ? '' : body).replace(/(\?t=)[A-Za-z0-9._\-]+/g, '$1<redacted>');
}

function isPastDeadline(now = new Date()) {
  const t = now instanceof Date ? now : new Date(now);
  return Number.isFinite(GUEST_DEADLINE_UTC.getTime()) && t.getTime() > GUEST_DEADLINE_UTC.getTime();
}

// Produces the payload an auto-declined household should end up with.
//
// Fills every unanswered `attending` with false and leaves explicit answers
// alone. Course picks, dietary notes and song requests attached to a
// now-declined attendee are dropped by payload.validatePayload itself, so we
// don't have to clear them here.
function buildAutoDeclinePayload(invite) {
  const existing = invite && invite.payload && typeof invite.payload === 'object' ? invite.payload : null;
  const rawPrimary = existing && existing.primary && typeof existing.primary === 'object' ? existing.primary : {};
  const draft = {
    primary: { ...rawPrimary },
    additionalGuests: Array.isArray(existing && existing.additionalGuests)
      ? existing.additionalGuests.filter((g) => g && typeof g === 'object').map((g) => ({ ...g }))
      : []
  };

  let flipped = 0;
  if (draft.primary.attending !== true && draft.primary.attending !== false) {
    draft.primary.attending = false;
    flipped += 1;
  }
  for (const guest of draft.additionalGuests) {
    if (guest.attending !== true && guest.attending !== false) {
      guest.attending = false;
      flipped += 1;
    }
  }

  const v = payloadLib.validatePayload(draft, { requireAttending: true });
  if (v.ok) {
    return { ok: true, json: v.json, payload: v.payload, flipped, degraded: false };
  }

  // A stored payload can carry a row the strict validator rejects -- most
  // plausibly an admin-created guest card that never got a name. Rather than
  // abandon the household, fall back to the same primary-only decline an
  // inbound SMS "NO" produces (sms_actions.applyNo). Flagged as degraded so
  // the run summary surfaces it instead of hiding the data loss.
  const notes = typeof draft.primary.notes === 'string' ? draft.primary.notes : '';
  const fallback = payloadLib.validatePayload(
    { primary: { attending: false, notes }, additionalGuests: [] },
    { requireAttending: true }
  );
  if (!fallback.ok) {
    return { ok: false, error: fallback.error || v.error };
  }
  return { ok: true, json: fallback.json, payload: fallback.payload, flipped: Math.max(flipped, 1), degraded: true };
}

// Classifies one invite without touching storage. Pure, so the dry run and the
// real run are guaranteed to agree about what would happen.
function planInvite(invite) {
  if (!invite || !invite.inviteId) {
    return { action: 'skip', reason: 'invalid_invite' };
  }
  if (invite.responded) {
    return { action: 'skip', reason: 'already_responded' };
  }

  const built = buildAutoDeclinePayload(invite);
  if (!built.ok) {
    return { action: 'skip', reason: 'payload_invalid', detail: built.error };
  }

  const summary = payloadLib.summarize(built.payload);
  if (summary.yes > 0) {
    // Someone in this household already said yes but the RSVP was never
    // completed. Recording the rest as no is defensible; texting them "you're
    // marked as not attending" is not. Hand it to the host.
    return { action: 'skip', reason: 'needs_review', built, summary };
  }

  let noTextReason = '';
  if (!invite.phoneNorm) noTextReason = 'no_phone';
  else if (invite.optedOutOfSms) noTextReason = 'opted_out';
  else if (invite.smsHardFailedAt) noTextReason = 'hard_failed';

  return {
    action: 'decline',
    built,
    summary,
    textable: !noTextReason,
    noTextReason
  };
}

function buildBodyForInvite(invite) {
  const locale = invite.locale === 'es' ? 'es' : 'en';
  return sms.buildAutoDeclineBody({
    locale,
    firstName: invite.primaryFirstName || '',
    lastName: invite.primaryLastName || '',
    deadlineDisplay: reminders.deadlineDisplay(locale),
    updateUntilDisplay: updateUntilDisplay(locale),
    siteOrigin: SITE_ORIGIN,
    magicToken: auth.signMagicToken(invite.inviteId)
  });
}

// Runs (or simulates) the sweep.
//
// opts:
//   dryRun  -- defaults to TRUE. Nothing is written or sent unless the caller
//              explicitly passes false. A sweep that texts the entire guest
//              list is not something to trigger by omission.
//   now     -- injectable clock for tests.
//   invites -- injectable invite list for tests.
//   force   -- run even before the deadline (test/staging only).
//   actor   -- audit-trail attribution for the run event. Defaults to 'cron';
//              the admin endpoint passes the signed-in admin instead.
async function runCutoff(context, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const log = (context && context.log) || (() => {});
  const logErr = (context && context.log && context.log.error) || (() => {});

  if (!isPastDeadline(now) && !opts.force) {
    return {
      ok: false,
      refused: 'before_deadline',
      deadlineUtc: GUEST_DEADLINE_UTC.toISOString(),
      now: now.toISOString()
    };
  }

  const invites = opts.invites || (await storage.listInvites());

  const declined = [];
  const texted = [];
  const sendFailed = [];
  const needsReview = [];
  const skipped = {};
  const bump = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };

  // Households can share a phone (a couple with two invite rows). Dedupe so
  // one handset gets one text, exactly as the reminder cron does.
  const dedupePhones = new Set();

  for (const invite of invites) {
    const plan = planInvite(invite);

    if (plan.action !== 'decline') {
      if (plan.reason === 'needs_review') {
        needsReview.push({
          inviteId: invite.inviteId,
          lastName: invite.primaryLastName || '',
          yes: plan.summary.yes,
          pending: plan.summary.pending
        });
      }
      bump(plan.reason);
      continue;
    }

    const row = {
      inviteId: invite.inviteId,
      lastName: invite.primaryLastName || '',
      locale: invite.locale === 'es' ? 'es' : 'en',
      flipped: plan.built.flipped,
      degraded: plan.built.degraded,
      textable: plan.textable,
      noTextReason: plan.noTextReason
    };

    // Suppress a second text to a handset already covered by this run, but
    // still record the decline -- the headcount is per household.
    const duplicatePhone = plan.textable && dedupePhones.has(invite.phoneNorm);
    if (duplicatePhone) {
      row.textable = false;
      row.noTextReason = 'dup_phone';
    }

    if (dryRun) {
      declined.push(row);
      if (row.textable) {
        dedupePhones.add(invite.phoneNorm);
        // Surface the real rendered copy + segment count so the host reviews
        // exactly what would go out, not an approximation of it.
        const body = buildBodyForInvite(invite);
        texted.push({ ...row, bodyPreview: redactToken(body), bodyLen: body.length, segments: sms.estimateSegments(body) });
      } else {
        bump(`not_texted_${row.noTextReason}`);
      }
      continue;
    }

    // Write BEFORE sending. If the send then fails we have a household that is
    // correctly declined but silently un-notified, which the run summary
    // reports and the host can chase. The reverse order risks re-texting
    // someone on a retry, which is the worse failure.
    try {
      await storage.markResponded(invite.inviteId, plan.built.json, {
        respondedAt: now.toISOString(),
        late: true,
        keepLocale: true,
        locale: invite.locale,
        autoDeclinedAt: now.toISOString()
      });
    } catch (err) {
      logErr(`cutoff decline_write_failed inviteId=${invite.inviteId}: ${err && err.message}`);
      bump('write_failed');
      continue;
    }
    declined.push(row);

    try {
      await storage.appendEvent({
        type: 'rsvp.auto_declined',
        actor: 'system:cutoff',
        summary: `${invite.primaryLastName || 'Unknown'} household auto-declined after the ${reminders.deadlineDisplay('en')} deadline`,
        meta: {
          inviteId: invite.inviteId,
          flipped: plan.built.flipped,
          degraded: plan.built.degraded,
          willText: row.textable,
          noTextReason: row.noTextReason
        }
      });
    } catch (err) {
      logErr(`cutoff event_write_failed inviteId=${invite.inviteId}: ${err && err.message}`);
    }

    if (!row.textable) {
      bump(`not_texted_${row.noTextReason}`);
      continue;
    }

    // Reserve the handset before attempting the send so a failure can't let a
    // second household on the same number try again in this run.
    dedupePhones.add(invite.phoneNorm);

    const body = buildBodyForInvite(invite);
    let result;
    try {
      result = await sms.sendSms(invite.phoneNorm, body, { tag: 'rsvp-cutoff' });
    } catch (err) {
      logErr(`cutoff send_threw inviteId=${invite.inviteId}: ${err && err.message}`);
      result = { successful: false, deliveryStatus: 'exception', errorCode: 'EXCEPTION', errorMessage: (err && err.message) || String(err) };
    }

    const auditBody = redactToken(body);
    try {
      await storage.appendSmsLog(invite.inviteId, {
        type: 'auto_decline',
        body: auditBody,
        bodyLen: body.length,
        toPhone: invite.phoneNorm,
        deliveryStatus: result.deliveryStatus,
        errorCode: result.errorCode,
        correlationId: result.messageId
      });
    } catch (err) {
      logErr(`cutoff smslog_failed inviteId=${invite.inviteId}: ${err && err.message}`);
    }

    if (result.successful) {
      texted.push({ ...row, messageId: result.messageId, segments: result.segmentCount, bodyLen: body.length });
    } else {
      sendFailed.push({ ...row, errorCode: result.errorCode || '', errorMessage: result.errorMessage || '' });
      bump('send_failed');
      if (reminders.isHardFailure(result.deliveryStatus, result.errorCode)) {
        try {
          await storage.patchInvite(invite.inviteId, { smsHardFailedAt: new Date().toISOString() });
        } catch (err) {
          logErr(`cutoff hardfail_mark_failed inviteId=${invite.inviteId}: ${err && err.message}`);
        }
      }
    }
  }

  const summary = {
    ok: true,
    dryRun,
    ranAt: now.toISOString(),
    deadlineUtc: GUEST_DEADLINE_UTC.toISOString(),
    // A dry run can legitimately be rehearsed months early (force). Say so in
    // the result, because before the deadline the outstanding count is a
    // worst case -- it includes people who simply have not replied *yet*.
    pastDeadline: isPastDeadline(now),
    updateUntilUtc: PERMANENT_LOCK_UTC.toISOString(),
    totalInvites: invites.length,
    declined: declined.length,
    texted: texted.length,
    sendFailed: sendFailed.length,
    needsReview,
    skipped,
    declinedRows: declined,
    textedRows: texted,
    sendFailedRows: sendFailed
  };

  log(`cutoff ${dryRun ? 'DRY-RUN' : 'EXECUTE'} declined=${declined.length} texted=${texted.length} sendFailed=${sendFailed.length} needsReview=${needsReview.length} skipped=${JSON.stringify(skipped)}`);

  if (!dryRun) {
    try {
      await storage.appendEvent({
        type: 'cron.rsvp_cutoff_run',
        // Who pulled the trigger. The cron workflow is not the only caller --
        // the admin page can run this too, and the audit trail should say
        // which human did it rather than blaming "cron" for all of them.
        actor: opts.actor || 'cron',
        summary: `RSVP cutoff: auto-declined ${declined.length}, texted ${texted.length}${sendFailed.length ? `, ${sendFailed.length} send failures` : ''}${needsReview.length ? `, ${needsReview.length} need review` : ''}`,
        meta: {
          declined: declined.length,
          texted: texted.length,
          sendFailed: sendFailed.length,
          needsReview: needsReview.length,
          skipped,
          totalInvites: invites.length
        }
      });
    } catch (err) {
      logErr(`cutoff run_event_write_failed: ${err && err.message}`);
    }
  }

  return summary;
}

module.exports = {
  runCutoff,
  planInvite,
  buildAutoDeclinePayload,
  buildBodyForInvite,
  updateUntilDisplay,
  isPastDeadline,
  GUEST_DEADLINE_UTC,
  PERMANENT_LOCK_UTC
};
