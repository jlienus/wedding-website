'use strict';

// SMS sending abstraction. Defaults to Azure Communication Services; can be
// switched to Twilio for pre-verification dev/testing by setting
// SMS_PROVIDER=twilio. Both branches return the same shape so callers
// (admin_send_test, cron_reminders, etc.) don't care which provider ran.

function provider() {
  return (process.env.SMS_PROVIDER || 'acs').toLowerCase();
}

// --- ACS branch ---------------------------------------------------------
let _acsClient = null;
let _acsFrom = null;

function getAcsClient() {
  if (_acsClient) return { client: _acsClient, from: _acsFrom };
  const cs = process.env.ACS_CONNECTION;
  const from = process.env.ACS_SMS_FROM;
  if (!cs) throw new Error('CONFIG_MISSING_ACS_CONNECTION');
  if (!from) throw new Error('CONFIG_MISSING_ACS_SMS_FROM');
  const { SmsClient } = require('@azure/communication-sms');
  _acsClient = new SmsClient(cs);
  _acsFrom = from;
  return { client: _acsClient, from: _acsFrom };
}

async function sendViaAcs(toPhone, body, opts) {
  const { client, from } = getAcsClient();
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

// --- Twilio branch (dev/testing) ---------------------------------------
let _twilioClient = null;
let _twilioFrom = null;

function getTwilioClient() {
  if (_twilioClient) return { client: _twilioClient, from: _twilioFrom };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid) throw new Error('CONFIG_MISSING_TWILIO_ACCOUNT_SID');
  if (!token) throw new Error('CONFIG_MISSING_TWILIO_AUTH_TOKEN');
  if (!from) throw new Error('CONFIG_MISSING_TWILIO_FROM');
  const twilio = require('twilio');
  _twilioClient = twilio(sid, token);
  _twilioFrom = from;
  return { client: _twilioClient, from: _twilioFrom };
}

async function sendViaTwilio(toPhone, body, _opts) {
  let client, from;
  try {
    ({ client, from } = getTwilioClient());
  } catch (err) {
    return {
      successful: false,
      messageId: '',
      deliveryStatus: 'send_failed',
      errorCode: (err && err.message) || 'CONFIG_ERROR',
      errorMessage: (err && err.message) || String(err),
      segmentCount: 0
    };
  }
  // statusCallback wires Twilio's delivery-lifecycle POSTs back to our
  // webhook so we can update sms_logs and mark hard-fail / opt-out flags.
  // Per-message rather than account-wide because Twilio recommends it and
  // it lets us swap providers / endpoints without Console config.
  const cbUrl = process.env.TWILIO_STATUS_CALLBACK_URL
    || ((process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com').replace(/\/$/, '') + '/api/twilio/webhook');
  const createParams = { from, to: toPhone, body };
  if (cbUrl) createParams.statusCallback = cbUrl;
  try {
    const msg = await client.messages.create(createParams);
    const status = String(msg.status || '').toLowerCase();
    // Twilio status values: queued, sending, sent, delivered, undelivered, failed.
    // queued/accepted/sending/sent/delivered are all "we successfully handed it
    // off"; final delivery state comes later via status callbacks.
    const accepted = ['queued', 'accepted', 'sending', 'sent', 'delivered'].includes(status);
    return {
      successful: accepted,
      messageId: msg.sid || '',
      deliveryStatus: accepted ? 'accepted' : (status || 'unknown'),
      errorCode: msg.errorCode != null ? String(msg.errorCode) : '',
      errorMessage: msg.errorMessage || '',
      segmentCount: estimateSegments(body)
    };
  } catch (err) {
    return {
      successful: false,
      messageId: '',
      deliveryStatus: 'send_failed',
      errorCode: err && (err.code != null ? String(err.code) : (err.status != null ? `HTTP_${err.status}` : 'EXCEPTION')),
      errorMessage: (err && err.message) || String(err),
      segmentCount: 0
    };
  }
}

// --- Dispatch ----------------------------------------------------------
// Returns: { successful, messageId, deliveryStatus, errorCode, errorMessage, segmentCount }
async function sendSms(toPhone, body, opts = {}) {
  if (provider() === 'twilio') return sendViaTwilio(toPhone, body, opts);
  return sendViaAcs(toPhone, body, opts);
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
