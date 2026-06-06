'use strict';

// Admin "send a test SMS to my own number" endpoint. Used to verify ACS
// credentials + phone provisioning + opt-out language are working. Body is
// a fixed test string, NOT a real magic link, so admins can't accidentally
// "claim" a guest's RSVP slot via the link.

const { preflight, isAllowedOrigin } = require('../_lib/cors');
const auth = require('../_lib/auth');
const storage = require('../_lib/storage');
const sms = require('../_lib/sms');

module.exports = async function (context, req) {
  const pre = preflight(req, 'POST, OPTIONS');
  if (pre.handled) { context.res = pre.response; return; }
  const { cors, origin } = pre;

  if (req.method !== 'POST') {
    context.res = { status: 405, headers: cors, body: { error: 'method_not_allowed' } };
    return;
  }
  if (!isAllowedOrigin(origin)) {
    context.res = { status: 403, headers: cors, body: { error: 'origin_not_allowed' } };
    return;
  }
  if (!auth.isAdmin(req)) {
    context.res = { status: 403, headers: cors, body: { error: 'admin_required' } };
    return;
  }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { payload = null; }
  if (!payload || typeof payload !== 'object' || typeof payload.phone !== 'string') {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_payload', message: 'expected { phone: string, locale?: "en"|"es" }' } };
    return;
  }

  const phone = storage.normalizePhone(payload.phone);
  if (!phone || !/^\+1\d{10}$/.test(phone)) {
    context.res = { status: 400, headers: cors, body: { error: 'invalid_phone', normalized: phone } };
    return;
  }

  const locale = payload.locale === 'es' ? 'es' : 'en';
  const body = locale === 'es'
    ? 'Test: sistema de RSVP de John & Diana funcionando. Si recibes esto, todo bien. Responde NO para declinar, STOP para no recibir mas mensajes.'
    : 'Test: John & Diana RSVP system is working. If you got this, all good. Reply NO to decline, STOP to opt out.';

  let result;
  try {
    result = await sms.sendSms(phone, body, { tag: 'rsvp-admin-test' });
  } catch (err) {
    context.log.error(`admin_send_test err: ${err && err.message}`);
    context.res = { status: 503, headers: cors, body: { error: 'send_failed', message: err && err.message } };
    return;
  }
  context.log(`admin_send_test phone=${phone} successful=${result.successful} status=${result.deliveryStatus}`);

  try {
    const principal = auth.readAdminPrincipal(req) || {};
    await storage.appendEvent({
      type: 'admin.test_sms_sent',
      actor: `admin:${String(principal.userDetails || 'unknown').toLowerCase()}`,
      summary: `Test SMS sent to ${phone} (${result.successful ? 'ok' : 'failed'}${result.errorCode ? `, code ${result.errorCode}` : ''})`,
      meta: { phone, locale, successful: !!result.successful, deliveryStatus: result.deliveryStatus, errorCode: result.errorCode }
    });
  } catch (err) {
    context.log.error(`admin_send_test event_write_failed: ${err && err.message}`);
  }

  context.res = {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: {
      ok: !!result.successful,
      successful: !!result.successful,
      messageId: result.messageId,
      deliveryStatus: result.deliveryStatus,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      segmentCount: result.segmentCount,
      bodyLen: body.length
    }
  };
};
