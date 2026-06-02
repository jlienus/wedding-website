'use strict';

// High-level "send a reminder to one party" helper. Used by:
//   - cron_reminders   (scheduled fan-out, respects cadence)
//   - admin_send_reminder (one-off, can override cadence)
//
// Decision matrix (in order):
//   1. settings.remindersEnabled OFF (and !overrideCadence) -> skip 'reminders_off'
//   2. now > remindersStopOnUtc (and !overrideCadence)      -> skip 'past_stop_date'
//   3. !party.phone                                          -> skip 'no_phone'
//   4. party.optedOutOfSms                                   -> skip 'opted_out'
//   5. party.smsHardFailedAt                                 -> skip 'hard_failed'
//   6. all members have a response with attending != null    -> skip 'already_responded'
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

function pickGreetingName(members) {
  if (!Array.isArray(members) || members.length === 0) return '';
  const primary = members.find((m) => m.role === 'primary') || members[0];
  return primary.firstName || '';
}

function allMembersResponded(members, responses) {
  if (!Array.isArray(members) || members.length === 0) return false;
  const byMember = new Map((responses || []).map((r) => [r.memberId, r]));
  return members.every((m) => {
    const r = byMember.get(m.memberId);
    return r && r.attending !== null && r.attending !== undefined;
  });
}

// Returns the canonical reason string for a delivery-status that should mark
// a party as permanently hard-failed (bad number, blocked, etc.). Soft errors
// (rate limits, transient) should NOT poison the party.
function isHardFailure(deliveryStatus, errorCode) {
  if (deliveryStatus === 'rejected') {
    if (!errorCode) return true;
    // 4xx from ACS = client problem (bad number, opted-out at carrier, etc.)
    if (/^HTTP_4/.test(errorCode)) return true;
  }
  return false;
}

async function sendReminderToParty(partyId, opts = {}) {
  const overrideCadence = !!opts.overrideCadence;
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

  const party = await storage.getParty(partyId);
  if (!party) return { ok: false, skipped: 'party_not_found' };
  if (!party.phoneNorm) return { ok: false, skipped: 'no_phone' };
  if (party.optedOutOfSms) return { ok: false, skipped: 'opted_out' };
  if (party.smsHardFailedAt) return { ok: false, skipped: 'hard_failed' };

  const [members, responses] = await Promise.all([
    storage.listMembers(partyId),
    storage.getResponses(partyId)
  ]);

  if (allMembersResponded(members, responses)) {
    return { ok: false, skipped: 'already_responded' };
  }

  if (!overrideCadence && party.lastReminderSentAt) {
    const last = new Date(party.lastReminderSentAt).getTime();
    if (Number.isFinite(last)) {
      const ageDays = (Date.now() - last) / DAY_MS;
      if (ageDays < MIN_DAYS_BETWEEN_REMINDERS) {
        return { ok: false, skipped: 'too_soon', daysSince: ageDays };
      }
    }
  }

  if (dedupePhones && dedupePhones.has(party.phoneNorm)) {
    return { ok: false, skipped: 'dup_phone' };
  }
  // Reserve the phone BEFORE we attempt the send so a failure doesn't let
  // a subsequent party sharing the same phone try again in the same run.
  if (dedupePhones) dedupePhones.add(party.phoneNorm);

  const locale = party.locale === 'es' ? 'es' : 'en';
  const magicToken = auth.signMagicToken(partyId);
  const body = sms.buildReminderBody({
    locale,
    firstName: pickGreetingName(members),
    deadlineDisplay: deadlineDisplay(locale),
    siteOrigin: SITE_ORIGIN,
    magicToken
  });

  const result = await sms.sendSms(party.phoneNorm, body, { tag: opts.tag || 'rsvp-reminder' });

  const logRowKey = await storage.appendSmsLog(partyId, {
    type: opts.type || 'reminder',
    body,
    toPhone: party.phoneNorm,
    deliveryStatus: result.deliveryStatus,
    errorCode: result.errorCode,
    correlationId: result.messageId
  });

  if (result.successful) {
    await storage.patchParty(partyId, {
      lastReminderSentAt: new Date().toISOString(),
      reminderCount: (party.reminderCount || 0) + 1
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
    await storage.patchParty(partyId, {
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
  sendReminderToParty,
  deadlineDisplay,
  isHardFailure,
  MIN_DAYS_BETWEEN_REMINDERS
};
