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

// Sends a transactional email and returns as soon as ACS has ACCEPTED the
// message for delivery (i.e. the underlying HTTP POST that begins the
// long-running send completed). We do NOT wait for the LRO to reach
// terminal Succeeded/Failed status -- that adds 5-15 seconds to every
// user-facing send for zero UX benefit, since:
//   * the caller (admin_login_request) always returns a generic 200
//     regardless of outcome (anti-enumeration), so terminal status does
//     not change the user response
//   * ACS reports "Succeeded" once the message is handed to the recipient
//     MTA -- it cannot see downstream silent-drop behavior (e.g., outlook
//     consumer dropping `*.azurecomm.net` mail), so terminal status is a
//     poor proxy for actual deliverability anyway
//   * the audit log only needs the handoff signal, not the LRO terminal
//
// Returns:
//   { successful, messageId, status, errorCode, errorMessage }
//
// `status` is 'Initiated' on the happy path; 'rejected' / 'send_failed'
// on the error paths below. `successful` is true iff beginSend resolved
// without throwing. If we ever need terminal status for deliverability
// analytics, subscribe to ACS Event Grid events instead of blocking the
// request thread on pollUntilDone().
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

  // Extract whatever messageId / id ACS already populated on the operation
  // state. This is best-effort -- ACS Email's PollerLike does not formally
  // guarantee an id pre-poll, but in practice the Operation-Location
  // header gives the SDK enough context to populate `result.id` (a.k.a.
  // the eventual messageId) from the initial 202 response.
  let messageId = '';
  try {
    const initial = poller.getOperationState();
    messageId = (initial && initial.result && initial.result.id) || (initial && initial.id) || '';
  } catch { /* messageId stays '' */ }

  // Drain the poller in the background so the SDK doesn't log unhandled-
  // promise warnings if it has internal retries scheduled. We do not await
  // and we silently swallow any failures -- they would only surface
  // recipient-side drops that ACS already cannot see reliably anyway.
  try {
    const drain = poller.pollUntilDone();
    if (drain && typeof drain.then === 'function') {
      drain.catch(() => { /* no-op */ });
    }
  } catch { /* no-op */ }

  return {
    successful: true,
    messageId,
    status: 'Initiated',
    errorCode: '',
    errorMessage: ''
  };
}

module.exports = { sendEmail };
