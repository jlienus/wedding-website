'use strict';

// Event Grid webhook for ACS SMS events.
//
// Two event types we care about:
//   Microsoft.Communication.SMSReceived        -> inbound SMS (STOP handling)
//   Microsoft.Communication.SMSDeliveryReportReceived -> outbound status update
//
// Also handles the Event Grid subscription-validation handshake on both the
// legacy SubscriptionValidationEvent and the CloudEvents OPTIONS-based flow.
//
// Endpoint is anonymous because Event Grid does not authenticate by default.
// Defense in depth:
//   - If env var ACS_WEBHOOK_SECRET is set, we require it as ?s=<secret> on
//     the URL and reject every other request. Configure the Event Grid
//     subscription's webhook URL with the same secret.
//   - We validate the event structure and only act on known types. The
//     action surface is small (set opted-out, update log status).

const storage = require('../_lib/storage');
const { isHardFailure } = require('../_lib/reminders');
const { timingSafeEqual } = require('crypto');

const STOP_KEYWORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'opt out', 'optout', 'opt-out'
]);
const START_KEYWORDS = new Set([
  'start', 'unstop', 'yes', 'opt in', 'optin', 'opt-in'
]);

function classifyKeyword(message) {
  if (typeof message !== 'string') return null;
  const t = message.trim().toLowerCase().replace(/[.!?,;]+$/, '');
  if (STOP_KEYWORDS.has(t)) return 'stop';
  if (START_KEYWORDS.has(t)) return 'start';
  return null;
}

function checkWebhookSecret(req) {
  const expected = process.env.ACS_WEBHOOK_SECRET || '';
  if (!expected) return true; // no secret configured -> allow (back-compat)
  const got = (req.query && (req.query.s || req.query.secret)) || '';
  if (typeof got !== 'string' || got.length === 0) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

async function findSmsLogByMessageId(messageId) {
  if (!messageId) return null;
  const c = storage.getClients();
  // Most recent first (reverse-timestamp row keys). Scan up to a few hundred.
  let scanned = 0;
  for await (const e of c.smslog.listEntities()) {
    if (e.correlationId === messageId) {
      return { partitionKey: e.partitionKey, rowKey: e.rowKey };
    }
    if (++scanned >= 500) break;
  }
  return null;
}

async function handleSmsReceived(context, data) {
  const fromPhone = data && data.from ? String(data.from) : '';
  const message = data && data.message ? String(data.message) : '';
  const phoneNorm = storage.normalizePhone(fromPhone);
  const keyword = classifyKeyword(message);

  context.log(`sms_webhook inbound from=${phoneNorm} keyword=${keyword || 'none'}`);

  // STOP/START is a consent action on the PHONE, not a single party. If two
  // households share a number, opting out one without the other would still
  // send to the second on the next cycle — wrong for SMS consent.
  const parties = await storage.findPartiesByPhoneNorm(phoneNorm);
  if (parties.length === 0) {
    context.log(`sms_webhook inbound no party for phone=${phoneNorm}`);
    return;
  }

  for (const party of parties) {
    try {
      await storage.appendSmsLog(party.partyId, {
        type: 'inbound',
        body: message,
        toPhone: phoneNorm, // for inbound, this is the sender's number
        deliveryStatus: 'received',
        errorCode: keyword || '',
        correlationId: (data && data.messageId) || ''
      });
    } catch (err) {
      context.log.error(`sms_webhook log inbound err: ${err && err.message}`);
    }
    if (keyword === 'stop' && !party.optedOutOfSms) {
      try {
        await storage.patchParty(party.partyId, { optedOutOfSms: true });
        context.log(`sms_webhook OPTED OUT partyId=${party.partyId}`);
      } catch (err) {
        context.log.error(`sms_webhook optout err: ${err && err.message}`);
      }
    } else if (keyword === 'start' && party.optedOutOfSms) {
      try {
        await storage.patchParty(party.partyId, { optedOutOfSms: false });
        context.log(`sms_webhook OPTED IN partyId=${party.partyId}`);
      } catch (err) {
        context.log.error(`sms_webhook optin err: ${err && err.message}`);
      }
    }
  }
}

async function handleDeliveryReport(context, data) {
  const messageId = data && data.messageId ? String(data.messageId) : '';
  const rawStatus = data && data.deliveryStatus ? String(data.deliveryStatus) : '';
  const errorCode = data && data.deliveryStatusDetails && data.deliveryStatusDetails.deliveryStatusMessage
    ? String(data.deliveryStatusDetails.deliveryStatusMessage)
    : '';
  if (!messageId) return;
  const match = await findSmsLogByMessageId(messageId);
  if (!match) {
    context.log(`sms_webhook delivery report no match for messageId=${messageId}`);
    return;
  }
  const status = (rawStatus || 'unknown').toLowerCase();
  try {
    await storage.updateSmsLogStatus(match.partitionKey, match.rowKey, status, errorCode);
    context.log(`sms_webhook delivery report messageId=${messageId} status=${status}`);
  } catch (err) {
    context.log.error(`sms_webhook delivery update err: ${err && err.message}`);
  }
  // If this is a hard failure (number invalid, blocked, etc.), mark the
  // party so the cron never tries again. Only stamp it if not already set.
  if (isHardFailure(status, errorCode)) {
    try {
      const party = await storage.getParty(match.partitionKey);
      if (party && !party.smsHardFailedAt) {
        await storage.patchParty(match.partitionKey, { smsHardFailedAt: new Date().toISOString() });
        context.log(`sms_webhook HARD FAIL partyId=${match.partitionKey} status=${status}`);
      }
    } catch (err) {
      context.log.error(`sms_webhook hardfail patch err: ${err && err.message}`);
    }
  }
}

module.exports = async function (context, req) {
  if (!checkWebhookSecret(req)) {
    context.log.warn('sms_webhook 403 invalid_secret');
    context.res = { status: 403, body: { error: 'invalid_secret' } };
    return;
  }

  // CloudEvents 1.0: Event Grid sends an OPTIONS request with the
  // WebHook-Request-Origin header for validation. ACS may also use the
  // legacy schema with SubscriptionValidationEvent.
  if (req.method === 'OPTIONS') {
    const reqOrigin = (req.headers && (req.headers['webhook-request-origin'] || req.headers['WebHook-Request-Origin'])) || '';
    context.res = {
      status: 200,
      headers: {
        'WebHook-Allowed-Origin': reqOrigin || '*',
        'WebHook-Allowed-Rate': '*'
      }
    };
    return;
  }

  // Event Grid sends an array of events (legacy schema) or a single
  // CloudEvent (CloudEvents 1.0 schema). Handle both.
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    context.res = { status: 400, body: { error: 'invalid_json' } };
    return;
  }

  const events = Array.isArray(body) ? body : [body];

  // Subscription validation handshake (legacy Event Grid schema).
  for (const ev of events) {
    if (!ev) continue;
    const eventType = ev.eventType || ev.type || '';
    if (eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
      const code = ev.data && ev.data.validationCode;
      context.log(`sms_webhook validation handshake code=${code}`);
      context.res = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { validationResponse: code }
      };
      return;
    }
  }

  for (const ev of events) {
    if (!ev) continue;
    const eventType = ev.eventType || ev.type || '';
    const data = ev.data || {};
    try {
      if (eventType === 'Microsoft.Communication.SMSReceived') {
        await handleSmsReceived(context, data);
      } else if (eventType === 'Microsoft.Communication.SMSDeliveryReportReceived') {
        await handleDeliveryReport(context, data);
      } else {
        context.log(`sms_webhook ignoring eventType=${eventType}`);
      }
    } catch (err) {
      context.log.error(`sms_webhook handler err type=${eventType}: ${err && err.message}`);
    }
  }

  context.res = { status: 200, body: { ok: true, processed: events.length } };
};
