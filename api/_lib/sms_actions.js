'use strict';

// Helpers for SMS-driven RSVP actions. Used by api/twilio_webhook (and
// potentially api/sms_webhook if/when we wire NO/YES into ACS too).
//
// Responsibilities:
//   - classifyInbound(text): map the raw body to a canonical action keyword
//     (stop|start|help|no|yes|other).
//   - applyNo(invite): mark the invite as declined ("primary-only, attending
//     false, no additional guests"), fire admin email, log event. Idempotent.
//   - replyNo(invite) / replyYes(invite): build the localized SMS reply body
//     including a magic link back to the form.
//
// Design note: an SMS "NO" speaks only for the primary contact. We do not have
// the additional guests' names stored on the invite (those exist only inside
// the response payload), so we record a single-attendee declined response. The
// host can interpret per their knowledge of the household; the audit log
// preserves the channel.

const storage = require('./storage');
const auth = require('./auth');
const payload = require('./payload');
const notify = require('./notify');

const SITE_ORIGIN = (process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com').replace(/\/$/, '');

// Keywords carrier/Twilio also auto-handle but we still want to classify so
// we can persist the consent state and log the inbound message.
const STOP_KEYWORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit',
  'opt out', 'optout', 'opt-out'
]);
const START_KEYWORDS = new Set([
  'start', 'unstop', 'opt in', 'optin', 'opt-in'
]);
const HELP_KEYWORDS = new Set(['help', 'info']);

// RSVP-action keywords. Permissive aliases — wedding guests will not type the
// exact word we expect. Stay conservative: only count obvious responses.
const NO_KEYWORDS = new Set([
  'no', 'n', 'nope',
  'no thanks', 'no thank you',
  'not attending', 'cannot attend', "can't attend",
  'cant make it', "can't make it",
  'decline', 'declined'
]);
const YES_KEYWORDS = new Set([
  'yes', 'y', 'yep', 'yup',
  'yes please',
  'attending', 'will attend',
  'rsvp yes', 'going'
]);

function classifyInbound(message) {
  if (typeof message !== 'string') return 'other';
  const t = message.trim().toLowerCase().replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ');
  if (!t) return 'other';
  if (STOP_KEYWORDS.has(t)) return 'stop';
  if (START_KEYWORDS.has(t)) return 'start';
  if (HELP_KEYWORDS.has(t)) return 'help';
  if (NO_KEYWORDS.has(t)) return 'no';
  if (YES_KEYWORDS.has(t)) return 'yes';
  return 'other';
}

function magicLink(inviteId) {
  return `${SITE_ORIGIN}/api/rsvp/magic?t=${auth.signMagicToken(inviteId)}`;
}

function replyNo(invite) {
  const lastName = invite.primaryLastName || '';
  const link = magicLink(invite.inviteId);
  if (invite.locale === 'es') {
    const who = lastName ? `la familia ${lastName}` : 'tu familia';
    return [
      `Recibido — ${who} ha sido marcada como no asistira.`,
      `Para cambiar:\n${link}`
    ].join('\n\n');
  }
  const who = lastName ? `the ${lastName} household` : 'your household';
  return [
    `Got it — ${who} is marked as not attending.`,
    `To change:\n${link}`
  ].join('\n\n');
}

function replyYes(invite) {
  const link = magicLink(invite.inviteId);
  if (invite.locale === 'es') {
    return [
      'Estupendo! Confirma los detalles y elige el menu aqui:',
      link
    ].join('\n\n');
  }
  return [
    'Great! Tap to confirm details and pick meals:',
    link
  ].join('\n\n');
}

// Marks the invite as declined-via-SMS (primary attending=false, zero
// additional guests). Fires the admin RSVP-update email and writes an audit
// event. Errors in side-effects (email, event log) are swallowed so the
// declined state still sticks — the same convention as rsvp_submit.
async function applyNo(context, invite, opts = {}) {
  const v = payload.validatePayload(
    { primary: { attending: false }, additionalGuests: [] },
    { requireAttending: true }
  );
  if (!v.ok) {
    throw new Error('applyNo_payload_invalid: ' + v.error);
  }

  const respondedAt = opts.respondedAt || new Date().toISOString();
  const isUpdate = !!invite.responded;
  await storage.markResponded(invite.inviteId, v.json, { late: !!opts.late, respondedAt });

  try {
    await storage.appendEvent({
      type: 'rsvp.declined_via_sms',
      actor: `invitee:${invite.primaryFirstName || ''} ${invite.primaryLastName || ''}`.trim(),
      summary: `${invite.primaryLastName || 'Unknown'} household declined via SMS reply`,
      meta: { inviteId: invite.inviteId, channel: 'sms', wasUpdate: isUpdate }
    });
  } catch (err) {
    if (context && context.log) context.log.error(`applyNo event_write_failed: ${err && err.message}`);
  }

  try {
    await notify.emailAdminsOfRsvpUpdate(context, {
      invite,
      payload: v.payload,
      summary: payload.summarize(v.payload),
      isUpdate,
      late: !!opts.late,
      receivedAt: respondedAt
    });
  } catch (err) {
    if (context && context.log) context.log.error(`applyNo email_notify_failed: ${err && err.message}`);
  }
}

module.exports = {
  classifyInbound,
  replyNo,
  replyYes,
  applyNo,
  magicLink
};
