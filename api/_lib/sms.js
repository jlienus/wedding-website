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
//
// Advertises only NO (decline) and STOP (opt out) as text-reply options.
// "Yes" RSVPs must go through the website so guests can pick meals,
// declare additional guests, etc. — capabilities SMS can't capture cleanly.
//
// Uses \n\n paragraph breaks for readability on iMessage / Android — costs
// the same chars as spaces (GSM-7 LF is one char), no extra segments.
function buildReminderBody({ locale, firstName, deadlineDisplay, siteOrigin, magicToken }) {
  const link = `${siteOrigin}/api/rsvp/magic?t=${magicToken}`;
  if (locale === 'es') {
    const greeting = firstName ? `Hola ${firstName},` : 'Hola,';
    return [
      greeting,
      `Recordatorio para confirmar tu asistencia a la boda de John & Diana antes del ${deadlineDisplay}.`,
      `Responde aqui:\n${link}`,
      'Responde NO para declinar o STOP para no recibir mas mensajes.'
    ].join('\n\n');
  }
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return [
    greeting,
    `Friendly reminder to RSVP for John & Diana's wedding by ${deadlineDisplay}.`,
    `Tap to respond:\n${link}`,
    'Reply NO to decline or STOP to opt out.'
  ].join('\n\n');
}

// Body for the SMS step-up auth "Text me a code" path. We DON'T mention NO
// or STOP here — this is a verification flow, not a marketing/reminder
// message, and conflating the two would let a guest opt out by replying to
// the code message. Compliance is satisfied by the periodic reminder SMS
// (which DOES advertise STOP) and the platform-level toll-free auto-reply.
function buildVerifyCodeBody({ locale, code }) {
  if (locale === 'es') {
    return [
      `Tu codigo de verificacion para el RSVP de John & Diana es:`,
      code,
      'Caduca en 10 minutos. Si no lo solicitaste, ignora este mensaje.'
    ].join('\n\n');
  }
  return [
    `Your John & Diana RSVP verification code is:`,
    code,
    'Expires in 10 minutes. If you did not request this, ignore this message.'
  ].join('\n\n');
}

// Body for the SMS step-up auth "Text me a link" path. Same magic-link
// token shape as the reminder body, but framed as a verification step
// (not a generic reminder) so it makes sense when the user just clicked
// "Text me a link" two seconds ago.
function buildVerifyLinkBody({ locale, siteOrigin, magicToken }) {
  const link = `${siteOrigin}/api/rsvp/magic?t=${magicToken}`;
  if (locale === 'es') {
    return [
      'Tu enlace para acceder al RSVP de John & Diana:',
      link,
      'Caduca en 10 minutos. Si no lo solicitaste, ignora este mensaje.'
    ].join('\n\n');
  }
  return [
    'Your John & Diana RSVP sign-in link:',
    link,
    'Expires in 10 minutes. If you did not request this, ignore this message.'
  ].join('\n\n');
}

module.exports = {
  sendSms,
  estimateSegments,
  buildReminderBody,
  buildVerifyCodeBody,
  buildVerifyLinkBody
};
