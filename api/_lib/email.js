'use strict';

// Wraps Azure Communication Services Email. Lazy-loaded so importing this
// module doesn't crash function cold-starts that don't need email.
//
// We reuse the same ACS_CONNECTION string that drives sms.js -- Email is a
// sub-resource of the same ACS namespace. Sender address comes from
// ACS_EMAIL_FROM and must be one of the verified MailFrom addresses on the
// Azure-managed sub-domain (or, in v2, on the custom domain).

let _client = null;
let _from = null;

function getClient() {
  if (_client) return { client: _client, from: _from };
  const cs = process.env.ACS_CONNECTION;
  const from = process.env.ACS_EMAIL_FROM;
  if (!cs) throw new Error('CONFIG_MISSING_ACS_CONNECTION');
  if (!from) throw new Error('CONFIG_MISSING_ACS_EMAIL_FROM');
  const { EmailClient } = require('@azure/communication-email');
  _client = new EmailClient(cs);
  _from = from;
  return { client: _client, from: _from };
}

// Sends a transactional email and waits for ACS to accept it for delivery.
//
// Returns:
//   { successful, messageId, status, errorCode, errorMessage }
//
// `status` is the ACS LRO terminal status string ('Succeeded' / 'Failed' /
// 'Canceled'). `successful` is true only when status === 'Succeeded'.
//
// We poll the LRO to completion rather than fire-and-forget because magic
// links MUST land in the user's inbox before they can sign in -- a silent
// drop here would make admin login look broken with no diagnostics.
async function sendEmail({ to, subject, html, plainText }) {
  if (!to || typeof to !== 'string') {
    return { successful: false, messageId: '', status: 'rejected', errorCode: 'BAD_TO', errorMessage: 'to required' };
  }
  if (!subject || typeof subject !== 'string') {
    return { successful: false, messageId: '', status: 'rejected', errorCode: 'BAD_SUBJECT', errorMessage: 'subject required' };
  }
  if (!html && !plainText) {
    return { successful: false, messageId: '', status: 'rejected', errorCode: 'BAD_BODY', errorMessage: 'html or plainText required' };
  }

  let client, from;
  try {
    ({ client, from } = getClient());
  } catch (err) {
    return {
      successful: false,
      messageId: '',
      status: 'rejected',
      errorCode: (err && err.message) || 'CONFIG_ERROR',
      errorMessage: (err && err.message) || String(err)
    };
  }

  const message = {
    senderAddress: from,
    recipients: { to: [{ address: to }] },
    content: {
      subject,
      ...(plainText ? { plainText } : {}),
      ...(html ? { html } : {})
    }
  };

  let poller;
  try {
    poller = await client.beginSend(message);
  } catch (err) {
    return {
      successful: false,
      messageId: '',
      status: 'send_failed',
      errorCode: (err && err.code) || 'EXCEPTION',
      errorMessage: (err && err.message) || String(err)
    };
  }

  let result;
  try {
    result = await poller.pollUntilDone();
  } catch (err) {
    return {
      successful: false,
      messageId: '',
      status: 'poll_failed',
      errorCode: (err && err.code) || 'EXCEPTION',
      errorMessage: (err && err.message) || String(err)
    };
  }

  const status = (result && result.status) || '';
  const messageId = (result && result.id) || '';
  const failureError = (result && result.error) || null;
  return {
    successful: status === 'Succeeded',
    messageId,
    status,
    errorCode: failureError ? (failureError.code || 'PROVIDER_ERR') : '',
    errorMessage: failureError ? (failureError.message || '') : ''
  };
}

module.exports = { sendEmail };
