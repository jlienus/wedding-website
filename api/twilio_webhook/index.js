'use strict';

// Twilio Programmable Messaging webhook. Handles two POST flows on a single
// endpoint, distinguished by which form fields Twilio sends:
//
//   1. INBOUND SMS — has `From`, `Body`, `MessageSid`. Fires when a guest
//      texts our number. We classify the body (STOP/START/HELP/NO/YES/other),
//      persist consent state on STOP/START, mark the invite declined on NO,
//      reply with TwiML for NO/YES, and let Twilio's platform-level auto-
//      replies handle STOP/START/HELP confirmations.
//
//   2. STATUS CALLBACK — has `MessageSid`, `MessageStatus`, optionally
//      `ErrorCode`. Fires for outbound message lifecycle. We update the SMS
//      log, mark smsHardFailedAt on permanent failures, and OPT OUT the
//      invite if Twilio returns 21610 (recipient previously unsubscribed).
//
// Anonymous auth — Twilio cannot present a function key. Security:
//   - Validate X-Twilio-Signature HMAC over the exact URL + sorted POST
//     params (Twilio SDK's validateRequest does this).
//   - Hard 403 if the signature doesn't match TWILIO_AUTH_TOKEN.
//
// Twilio Console wiring (one-time, manual):
//   Phone Numbers > Manage > Active Numbers > <your TF number> > Messaging
//   Configuration > "A message comes in" > Webhook >
//     URL: https://johnanddianaswedding.com/api/twilio/webhook
//     HTTP: POST
//   (Status callbacks are wired per-outbound-message in api/_lib/sms.js via
//   the `statusCallback` param — no Console config needed for those.)

const storage = require('../_lib/storage');
const { isHardFailure } = require('../_lib/reminders');
const actions = require('../_lib/sms_actions');

const SITE_ORIGIN = (process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com').replace(/\/$/, '');
const WEBHOOK_URL = SITE_ORIGIN + '/api/twilio/webhook';

// Twilio sends application/x-www-form-urlencoded. Azure Functions on the SWA
// managed plan inconsistently parses it — sometimes pre-parsed object,
// sometimes raw string, occasionally Buffer in rawBody. Normalize all three.
function parseFormBody(req) {
  if (req && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const out = {};
    for (const [k, v] of Object.entries(req.body)) out[k] = String(v);
    return out;
  }
  const raw = (req && typeof req.body === 'string' ? req.body
    : req && req.rawBody ? String(req.rawBody) : '');
  if (!raw) return {};
  return Object.fromEntries(new URLSearchParams(raw));
}

function verifySignature(req, params) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const sig = (req.headers && (req.headers['x-twilio-signature'] || req.headers['X-Twilio-Signature'])) || '';
  if (!sig) return false;
  let twilio;
  try { twilio = require('twilio'); } catch { return false; }
  try {
    return twilio.validateRequest(token, String(sig), WEBHOOK_URL, params);
  } catch {
    return false;
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Empty-Response TwiML for "we processed this but don't want to reply" — e.g.,
// STOP/START/HELP (Twilio auto-replies with its own message) and status
// callbacks (Twilio doesn't expect a reply at all).
function twimlResponse(messageBody) {
  const inner = messageBody ? `<Message>${escapeXml(messageBody)}</Message>` : '';
  return {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`
  };
}

async function handleInbound(context, params) {
  const fromPhone = String(params.From || '');
  const message = String(params.Body || '');
  const messageSid = String(params.MessageSid || '');
  const phoneNorm = storage.normalizePhone(fromPhone);
  const kind = actions.classifyInbound(message);

  context.log(`twilio_webhook inbound from=${phoneNorm} kind=${kind} sid=${messageSid}`);

  const invites = await storage.findInvitesByPhoneNorm(phoneNorm);
  if (invites.length === 0) {
    context.log(`twilio_webhook inbound no_invite for=${phoneNorm}`);
    return twimlResponse(null);
  }

  let reply = null;
  for (const invite of invites) {
    try {
      await storage.appendSmsLog(invite.inviteId, {
        type: 'inbound',
        body: message,
        toPhone: phoneNorm,
        deliveryStatus: 'received',
        errorCode: kind === 'other' ? '' : kind,
        correlationId: messageSid
      });
    } catch (err) {
      context.log.error(`twilio_webhook log_inbound_err: ${err && err.message}`);
    }

    if (kind === 'stop' && !invite.optedOutOfSms) {
      try {
        await storage.patchInvite(invite.inviteId, { optedOutOfSms: true });
        context.log(`twilio_webhook OPTED_OUT inviteId=${invite.inviteId}`);
      } catch (err) {
        context.log.error(`twilio_webhook optout_err: ${err && err.message}`);
      }
    } else if (kind === 'start' && invite.optedOutOfSms) {
      try {
        await storage.patchInvite(invite.inviteId, { optedOutOfSms: false });
        context.log(`twilio_webhook OPTED_IN inviteId=${invite.inviteId}`);
      } catch (err) {
        context.log.error(`twilio_webhook optin_err: ${err && err.message}`);
      }
    } else if (kind === 'no') {
      try {
        await actions.applyNo(context, invite);
        context.log(`twilio_webhook DECLINED inviteId=${invite.inviteId}`);
        if (!reply) reply = actions.replyNo(invite);
      } catch (err) {
        context.log.error(`twilio_webhook applyNo_err: ${err && err.message}`);
      }
    } else if (kind === 'yes') {
      if (!reply) reply = actions.replyYes(invite);
    }
  }
  return twimlResponse(reply);
}

async function handleStatusCallback(context, params) {
  const messageSid = String(params.MessageSid || '');
  const rawStatus = String(params.MessageStatus || '').toLowerCase();
  const errorCode = String(params.ErrorCode || '');
  if (!messageSid) return twimlResponse(null);

  // Only act on terminal states; transient ones (queued/sending/sent) just
  // produce log noise.
  const TERMINAL = new Set(['delivered', 'undelivered', 'failed']);
  if (!TERMINAL.has(rawStatus)) {
    return twimlResponse(null);
  }

  const match = await storage.findSmsLogByCorrelationId(messageSid);
  if (!match) {
    context.log(`twilio_webhook status no_match sid=${messageSid} status=${rawStatus}`);
    return twimlResponse(null);
  }

  try {
    await storage.updateSmsLogStatus(match.partitionKey, match.rowKey, rawStatus, errorCode);
    context.log(`twilio_webhook status sid=${messageSid} status=${rawStatus} err=${errorCode}`);
  } catch (err) {
    context.log.error(`twilio_webhook status_update_err: ${err && err.message}`);
  }

  // Twilio 21610 = "Attempt to send to unsubscribed recipient" — recipient
  // STOP'd at some point (possibly before we wired the webhook, or from a
  // different account). The semantically-correct state is opted-out, not
  // hard-failed, so future cron runs treat it as a consent decision.
  if (rawStatus === 'undelivered' && errorCode === '21610') {
    try {
      const invite = await storage.getInvite(match.partitionKey);
      if (invite && !invite.optedOutOfSms) {
        await storage.patchInvite(match.partitionKey, { optedOutOfSms: true });
        context.log(`twilio_webhook OPTED_OUT via 21610 inviteId=${match.partitionKey}`);
      }
    } catch (err) {
      context.log.error(`twilio_webhook optout_via_21610_err: ${err && err.message}`);
    }
    return twimlResponse(null);
  }

  if (isHardFailure(rawStatus, errorCode)) {
    try {
      const invite = await storage.getInvite(match.partitionKey);
      if (invite && !invite.smsHardFailedAt) {
        await storage.patchInvite(match.partitionKey, { smsHardFailedAt: new Date().toISOString() });
        context.log(`twilio_webhook HARD_FAIL inviteId=${match.partitionKey} status=${rawStatus} err=${errorCode}`);
        try {
          await storage.appendEvent({
            type: 'sms.delivery_failed',
            actor: `invitee:${invite.primaryFirstName || ''} ${invite.primaryLastName || ''}`.trim(),
            summary: `SMS hard-failed for ${invite.primaryLastName || 'unknown'} household (${invite.phoneNorm || 'unknown phone'}, ${rawStatus}${errorCode ? `, ${errorCode}` : ''})`,
            meta: { inviteId: match.partitionKey, phone: invite.phoneNorm, status: rawStatus, errorCode }
          });
        } catch (eventErr) {
          context.log.error(`twilio_webhook event_write_err: ${eventErr && eventErr.message}`);
        }
      }
    } catch (err) {
      context.log.error(`twilio_webhook hardfail_patch_err: ${err && err.message}`);
    }
  }
  return twimlResponse(null);
}

module.exports = async function (context, req) {
  if (req.method !== 'POST') {
    context.res = { status: 405, body: 'Method not allowed' };
    return;
  }

  const params = parseFormBody(req);

  if (!verifySignature(req, params)) {
    const ipHint = (req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'])) || 'unknown';
    context.log.warn(`twilio_webhook 403 invalid_signature from=${ipHint}`);
    context.res = { status: 403, body: 'Forbidden' };
    return;
  }

  try {
    // Status callbacks always carry `MessageStatus`; inbound never does.
    if (typeof params.MessageStatus === 'string' && params.MessageStatus.length > 0) {
      context.res = await handleStatusCallback(context, params);
    } else {
      context.res = await handleInbound(context, params);
    }
  } catch (err) {
    context.log.error(`twilio_webhook handler_err: ${err && err.message}`);
    // Still 200 so Twilio doesn't aggressively retry — we logged it; the
    // outbound message lifecycle isn't blocked by webhook failures.
    context.res = twimlResponse(null);
  }
};
