'use strict';

// Wraps Azure Communication Services SMS. Lazy-loaded so importing this
// module doesn't crash function cold-starts that don't need SMS.

let _client = null;
let _fromNumber = null;

function getClient() {
  if (_client) return { client: _client, from: _fromNumber };
  const cs = process.env.ACS_CONNECTION;
  const from = process.env.ACS_SMS_FROM;
  if (!cs) throw new Error('CONFIG_MISSING_ACS_CONNECTION');
  if (!from) throw new Error('CONFIG_MISSING_ACS_SMS_FROM');
  const { SmsClient } = require('@azure/communication-sms');
  _client = new SmsClient(cs);
  _fromNumber = from;
  return { client: _client, from: _fromNumber };
}

// Returns: { successful, messageId, deliveryStatus, errorCode, segmentCount }
async function sendSms(toPhone, body, opts = {}) {
  const { client, from } = getClient();
  const sendOpts = {
    enableDeliveryReport: true,
    tag: opts.tag || 'rsvp'
  };
  let results;
  try {
    results = await client.send({ from, to: [toPhone], message: body }, sendOpts);
  } catch (err) {
    return {
      successful: false,
      messageId: '',
      deliveryStatus: 'send_failed',
      errorCode: (err && err.code) || 'EXCEPTION',
      errorMessage: (err && err.message) || String(err),
      segmentCount: 0
    };
  }
  const r = Array.isArray(results) && results[0] ? results[0] : null;
  if (!r) {
    return {
      successful: false,
      messageId: '',
      deliveryStatus: 'send_failed',
      errorCode: 'NO_RESULT',
      segmentCount: 0
    };
  }
  return {
    successful: !!r.successful,
    messageId: r.messageId || '',
    deliveryStatus: r.successful ? 'accepted' : 'rejected',
    errorCode: r.httpStatusCode ? `HTTP_${r.httpStatusCode}` : (r.errorMessage ? 'PROVIDER_ERR' : ''),
    errorMessage: r.errorMessage || '',
    segmentCount: estimateSegments(body)
  };
}

// GSM-7 default alphabet check; messages with characters outside GSM-7 must
// be sent as UCS-2 (max 70 chars per segment vs 160). Conservative estimate.
const GSM7_REGEX = /^[\u0000-\u007F]*$/;

function estimateSegments(body) {
  const len = body.length;
  if (GSM7_REGEX.test(body)) {
    if (len <= 160) return 1;
    return Math.ceil(len / 153);
  }
  if (len <= 70) return 1;
  return Math.ceil(len / 67);
}

// Canonical reminder body in EN or ES. Token is the magic-link signed token
// (see _lib/auth.js signMagicToken). siteOrigin: canonical site URL, no slash.
function buildReminderBody({ locale, firstName, deadlineDisplay, siteOrigin, magicToken }) {
  const link = `${siteOrigin}/api/rsvp/magic?t=${magicToken}`;
  const greeting = firstName ? (locale === 'es' ? `Hola ${firstName}, ` : `Hi ${firstName}, `) : '';
  if (locale === 'es') {
    return `${greeting}recordatorio para confirmar tu asistencia a la boda de John & Diana antes del ${deadlineDisplay}. Responde aqui: ${link} Responde STOP para no recibir mas mensajes.`;
  }
  return `${greeting}friendly reminder to RSVP for John & Diana's wedding by ${deadlineDisplay}. Tap to respond: ${link} Reply STOP to opt out.`;
}

module.exports = {
  sendSms,
  estimateSegments,
  buildReminderBody
};
