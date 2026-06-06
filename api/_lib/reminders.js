'use strict';

// High-level "send a reminder to one invite" helper. Used by:
//   - cron_reminders        (scheduled fan-out, respects cadence + phone dedupe)
//   - admin_send_reminder   (one-off, can override cadence)
//
// Decision matrix (in order):
//   1. settings.remindersEnabled OFF (and !overrideCadence) -> skip 'reminders_off'
//   2. now > remindersStopOnUtc (and !overrideCadence)      -> skip 'past_stop_date'
//   3. !invite.phoneNorm                                     -> skip 'no_phone'
//   4. invite.optedOutOfSms                                  -> skip 'opted_out'
//   5. invite.smsHardFailedAt                                -> skip 'hard_failed'
//   6. invite.responded                                      -> skip 'already_responded'
//   7. !overrideCadence and lastReminderSentAt within 30d    -> skip 'too_soon'
//   8. dedupe: this phone already sent in this cron run      -> skip 'dup_phone'
//   ELSE send.

const storage = require('./storage');
const sms = require('./sms');
const auth = require('./auth');

const SITE_ORIGIN = (process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com').replace(/\/$/, '');
const MIN_DAYS_BETWEEN_REMINDERS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function deadlineDisplay(locale) {
  // Single, simple display string. Matches the printed cards: Nov 15.
  return locale === 'es' ? '15 de noviembre' : 'November 15';
}

// True if a delivery state should mark an invite permanently hard-failed (bad
// number, blocked, etc.). Soft errors (rate limits, transient) should NOT
// poison the invite. Recognizes both ACS-style and Twilio-style status codes.
//
// Note: Twilio error 21610 (recipient unsubscribed) is intentionally NOT in the
// hard-fail set. The twilio_webhook function handles it as an opt-out signal
// (sets optedOutOfSms) which is the more accurate state.
const HARD_TWILIO_ERROR_CODES = new Set([
  '30003', // Unreachable destination handset
  '30004', // Message blocked by carrier
  '30005', // Unknown destination handset
  '30006', // Landline / unreachable carrier
  '30007', // Carrier filtered (content blocked)
  '21211', // Invalid 'To' phone number
  '21408', // Permission to send to this region not enabled
  '21614'  // 'To' is not a valid mobile number
]);

function isHardFailure(deliveryStatus, errorCode) {
  const status = String(deliveryStatus || '').toLowerCase();
  const code = String(errorCode || '');

  // ACS pattern: rejected at send time with HTTP 4xx (e.g. invalid number) is
  // permanent. Bare rejected with no detail is also treated as permanent.
  if (status === 'rejected') {
    if (!code) return true;
    if (/^HTTP_4/.test(code)) return true;
  }

  // Twilio 'failed' = gave up before reaching carrier. Always permanent.
  if (status === 'failed') return true;

  // Twilio 'undelivered' = carrier accepted then rejected. Hard only for
  // codes that indicate a permanent condition.
  if (status === 'undelivered' && HARD_TWILIO_ERROR_CODES.has(code)) return true;

  return false;
}

async function sendReminderToInvite(inviteId, opts = {}) {
  const overrideCadence = !!(opts.overrideCadence || opts.force);
  const dedupePhones = opts.dedupePhones instanceof Set ? opts.dedupePhones : null;
  const settings = opts.settings || (await storage.getSettings());

  if (!overrideCadence && !settings.remindersEnabled) {
    return { ok: false, skipped: 'reminders_off' };
  }
  if (!overrideCadence && settings.remindersStopOnUtc) {
    const stop = new Date(settings.remindersStopOnUtc);
    if (Number.isFinite(stop.getTime()) && Date.now() > stop.getTime()) {
      return { ok: false, skipped: 'past_stop_date' };
    }
  }

  const invite = opts.invite || (await storage.getInvite(inviteId));
  if (!invite) return { ok: false, skipped: 'invite_not_found' };
  if (!invite.phoneNorm) return { ok: false, skipped: 'no_phone' };
  if (invite.optedOutOfSms) return { ok: false, skipped: 'opted_out' };
  if (invite.smsHardFailedAt) return { ok: false, skipped: 'hard_failed' };

  if (invite.responded) {
    return { ok: false, skipped: 'already_responded' };
  }

  if (!overrideCadence && invite.lastReminderSentAt) {
    const last = new Date(invite.lastReminderSentAt).getTime();
    if (Number.isFinite(last)) {
      const ageDays = (Date.now() - last) / DAY_MS;
      if (ageDays < MIN_DAYS_BETWEEN_REMINDERS) {
        return { ok: false, skipped: 'too_soon', daysSince: ageDays };
      }
    }
  }

  if (dedupePhones && dedupePhones.has(invite.phoneNorm)) {
    return { ok: false, skipped: 'dup_phone' };
  }
  // Reserve the phone BEFORE we attempt the send so a failure doesn't let a
  // subsequent invite sharing the same phone try again in the same run.
  if (dedupePhones) dedupePhones.add(invite.phoneNorm);

  const locale = invite.locale === 'es' ? 'es' : 'en';
  const magicToken = auth.signMagicToken(inviteId);
  const body = sms.buildReminderBody({
    locale,
    firstName: invite.primaryFirstName || '',
    deadlineDisplay: deadlineDisplay(locale),
    siteOrigin: SITE_ORIGIN,
    magicToken
  });

  const result = await sms.sendSms(invite.phoneNorm, body, { tag: opts.tag || 'rsvp-reminder' });

  // Strip the magic-link token from the stored audit body so a future
  // RSVP_MAGIC_SECRET leak combined with the audit log can't be turned
  // into a token replay. Keeps the rest of the body intact (deadline copy,
  // domain, etc.) for operator readability.
  const auditBody = body.replace(/(\?t=)[A-Za-z0-9._\-]+/g, '$1<redacted>');

  const logRowKey = await storage.appendSmsLog(inviteId, {
    type: opts.type || 'reminder',
    body: auditBody,
    bodyLen: body.length,
    toPhone: invite.phoneNorm,
    deliveryStatus: result.deliveryStatus,
    errorCode: result.errorCode,
    correlationId: result.messageId
  });

  if (result.successful) {
    await storage.patchInvite(inviteId, {
      lastReminderSentAt: new Date().toISOString(),
      reminderCount: (invite.reminderCount || 0) + 1
    });
    return {
      ok: true,
      sent: true,
      messageId: result.messageId,
      segmentCount: result.segmentCount,
      bodyLen: body.length,
      logRowKey
    };
  }

  if (isHardFailure(result.deliveryStatus, result.errorCode)) {
    await storage.patchInvite(inviteId, {
      smsHardFailedAt: new Date().toISOString()
    });
  }
  return {
    ok: false,
    sent: false,
    skipped: 'send_failed',
    errorCode: result.errorCode,
    errorMessage: result.errorMessage || '',
    logRowKey
  };
}

module.exports = {
  sendReminderToInvite,
  deadlineDisplay,
  isHardFailure,
  MIN_DAYS_BETWEEN_REMINDERS
};
