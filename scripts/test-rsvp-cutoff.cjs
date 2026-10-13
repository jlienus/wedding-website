'use strict';

// Unit tests for the post-deadline RSVP cutoff sweep (api/_lib/cutoff.js).
//
// Everything runs against injected invite lists and a stubbed storage / sms
// layer -- no Azure, and critically no real SMS. The whole point of this
// feature is that it can text the entire guest list in one call, so these
// tests assert as hard on *who must not be texted* as on who is.

process.env.RSVP_SITE_ORIGIN = 'https://johnanddianaswedding.com';
process.env.RSVP_MAGIC_SECRET = 'test-magic-secret-that-is-long-enough-32';
process.env.RSVP_GUEST_DEADLINE_UTC = '2026-11-15T23:59:59-05:00';
process.env.RSVP_PERMANENT_LOCK_UTC = '2027-01-15T23:59:59-05:00';

// --- stub storage + sms before cutoff.js pulls them in ---------------------
const storagePath = require.resolve('../api/_lib/storage');
const smsPath = require.resolve('../api/_lib/sms');

const calls = { markResponded: [], sent: [], smsLog: [], events: [], patched: [] };
const OK_SEND = { successful: true, messageId: 'SM-test', segmentCount: 2, deliveryStatus: 'queued' };
let sendBehavior = () => OK_SEND;

require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: {
    listInvites: async () => [],
    markResponded: async (inviteId, json, opts) => { calls.markResponded.push({ inviteId, json, opts }); },
    appendSmsLog: async (inviteId, entry) => { calls.smsLog.push({ inviteId, entry }); return 'row1'; },
    appendEvent: async (e) => { calls.events.push(e); },
    patchInvite: async (inviteId, patch) => { calls.patched.push({ inviteId, patch }); },
    ensureTables: async () => {}
  }
};

const realSms = require(smsPath);
require.cache[smsPath] = {
  id: smsPath,
  filename: smsPath,
  loaded: true,
  exports: {
    buildAutoDeclineBody: realSms.buildAutoDeclineBody,
    buildReminderBody: realSms.buildReminderBody,
    estimateSegments: realSms.estimateSegments,
    sendSms: async (to, body, opts) => { calls.sent.push({ to, body, opts }); return sendBehavior(to, body); }
  }
};

const cutoff = require('../api/_lib/cutoff');

// --- harness ---------------------------------------------------------------
let fails = 0;
let count = 0;
function ok(cond, label, extra) {
  count += 1;
  if (!cond) { fails += 1; console.log('FAIL:', label, extra === undefined ? '' : JSON.stringify(extra)); }
}
function eq(got, want, label) {
  ok(got === want, label, { got, want });
}
function reset() {
  calls.markResponded.length = 0;
  calls.sent.length = 0;
  calls.smsLog.length = 0;
  calls.events.length = 0;
  calls.patched.length = 0;
  sendBehavior = () => OK_SEND;
}

const AFTER = new Date('2026-11-16T12:00:00Z');
const BEFORE = new Date('2026-11-01T12:00:00Z');

function invite(over = {}) {
  return {
    inviteId: 'inv1',
    primaryFirstName: 'Ana',
    primaryLastName: 'Guajan',
    phone: '+15551230000',
    phoneNorm: '+15551230000',
    locale: 'en',
    optedOutOfSms: false,
    smsHardFailedAt: '',
    responded: false,
    payload: null,
    ...over
  };
}

function testBuildPayload() {
  {
    const r = cutoff.buildAutoDeclinePayload(invite());
    ok(r.ok, 'null payload -> builds');
    eq(r.payload.primary.attending, false, 'null payload -> primary declined');
    eq(r.payload.additionalGuests.length, 0, 'null payload -> no guests invented');
    eq(r.flipped, 1, 'null payload -> one flip');
  }
  {
    // The load-bearing safety property: an explicit yes is the guest's own
    // answer and must survive the sweep untouched.
    const r = cutoff.buildAutoDeclinePayload(invite({
      payload: {
        primary: { attending: true, mealChoice: 'beef' },
        additionalGuests: [
          { id: 'g_a', name: 'Bo', attending: null },
          { id: 'g_b', name: 'Cy', attending: false }
        ]
      }
    }));
    ok(r.ok, 'mixed payload -> builds');
    eq(r.payload.primary.attending, true, 'explicit YES preserved');
    eq(r.payload.primary.mealChoice, 'beef', 'attending guest keeps their meal');
    eq(r.payload.additionalGuests[0].attending, false, 'unanswered guest flipped to no');
    eq(r.payload.additionalGuests[1].attending, false, 'explicit NO left alone');
    eq(r.flipped, 1, 'only the unanswered guest counted as flipped');
  }
  {
    // Course picks on a now-declined attendee must not survive -- that is a
    // plate the caterer bills for and nobody eats.
    const r = cutoff.buildAutoDeclinePayload(invite({
      payload: { primary: { attending: null, mealChoice: 'chicken', dietary: 'nuts' }, additionalGuests: [] }
    }));
    eq(r.payload.primary.mealChoice, '', 'declined attendee loses mealChoice');
    eq(r.payload.primary.dietary, '', 'declined attendee loses dietary');
  }
  {
    const r = cutoff.buildAutoDeclinePayload(invite({
      payload: { primary: { attending: null, notes: 'sends love' }, additionalGuests: [] }
    }));
    eq(r.payload.primary.notes, 'sends love', 'primary notes preserved');
  }
  {
    // Unnamed guest card -> strict validation rejects it -> primary-only fallback.
    const r = cutoff.buildAutoDeclinePayload(invite({
      payload: { primary: { attending: null }, additionalGuests: [{ id: 'g_x', name: '', attending: null }] }
    }));
    ok(r.ok, 'unnamed guest -> still builds via fallback');
    ok(r.degraded, 'unnamed guest -> flagged degraded');
    eq(r.payload.additionalGuests.length, 0, 'fallback drops the invalid guest row');
    eq(r.payload.primary.attending, false, 'fallback still declines the primary');
  }
}

function testPlan() {
  eq(cutoff.planInvite(invite({ responded: true })).reason, 'already_responded', 'responded -> skipped');
  eq(cutoff.planInvite(invite()).action, 'decline', 'outstanding -> decline');
  eq(cutoff.planInvite(invite()).textable, true, 'has phone -> textable');
  eq(cutoff.planInvite(invite({ phoneNorm: '' })).textable, false, 'no phone -> not textable');
  eq(cutoff.planInvite(invite({ phoneNorm: '' })).noTextReason, 'no_phone', 'no phone -> reason recorded');
  eq(cutoff.planInvite(invite({ phoneNorm: '' })).action, 'decline', 'no phone -> still declined');
  eq(cutoff.planInvite(invite({ optedOutOfSms: true })).textable, false, 'opted out -> not textable');
  eq(cutoff.planInvite(invite({ optedOutOfSms: true })).action, 'decline', 'opted out -> still declined');
  eq(cutoff.planInvite(invite({ smsHardFailedAt: '2026-01-01' })).textable, false, 'hard-failed -> not textable');
  eq(
    cutoff.planInvite(invite({
      payload: { primary: { attending: true }, additionalGuests: [{ id: 'g_a', name: 'Bo', attending: null }] }
    })).reason,
    'needs_review',
    'household with a YES -> needs_review, never auto-declined'
  );
}

function testCopy() {
  {
    const body = cutoff.buildBodyForInvite(invite());
    ok(body.includes('November 15'), 'EN body names the deadline');
    ok(body.includes('January 15'), 'EN body names the change-by date');
    ok(body.includes('not attending'), 'EN body states the outcome');
    ok(body.includes('/api/rsvp/magic?t='), 'EN body carries a magic link');
    ok(body.includes('Guajan'), 'EN body names the household');
    ok(body.includes('STOP'), 'EN body advertises STOP');
    ok(!body.includes('anytime'), 'EN body does not overpromise "anytime"');
  }
  {
    const body = cutoff.buildBodyForInvite(invite({ locale: 'es' }));
    ok(body.includes('15 de noviembre'), 'ES body names the deadline');
    ok(body.includes('15 de enero'), 'ES body names the change-by date');
    ok(body.includes('/api/rsvp/magic?t='), 'ES body carries a magic link');
    // Accents force UCS-2 (70 chars/segment vs 160), inflating the cost and
    // segment count of every Spanish send.
    ok(/^[\u0000-\u007F]*$/.test(body), 'ES body stays inside GSM-7 (no accents)');
  }
  {
    const body = cutoff.buildBodyForInvite(invite({ primaryFirstName: '', primaryLastName: '' }));
    ok(body.startsWith('Hi,'), 'nameless invite still greets cleanly');
    ok(body.includes('your household'), 'nameless invite falls back to "your household"');
  }
}

async function testRefusesBeforeDeadline() {
  reset();
  const r = await cutoff.runCutoff(null, { dryRun: false, now: BEFORE, invites: [invite()] });
  eq(r.refused, 'before_deadline', 'pre-deadline execute is refused');
  eq(calls.markResponded.length, 0, 'pre-deadline -> no writes');
  eq(calls.sent.length, 0, 'pre-deadline -> no texts');
}

// The workflow lets you rehearse a dry run months early, so forcing past the
// date gate must still write and send nothing -- and must say it was early,
// since the outstanding count before the deadline is a worst case.
async function testForcedPreDeadlineDryRun() {
  reset();
  const r = await cutoff.runCutoff(null, {
    dryRun: true,
    force: true,
    now: BEFORE,
    invites: [invite(), invite({ inviteId: 'inv2', phoneNorm: '+15551230001' })]
  });
  eq(r.refused, undefined, 'force lets a pre-deadline dry run proceed');
  eq(r.dryRun, true, 'forced rehearsal is still a dry run');
  eq(r.pastDeadline, false, 'forced rehearsal reports it ran before the deadline');
  eq(r.declined, 2, 'forced rehearsal still previews the counts');
  eq(calls.markResponded.length, 0, 'forced rehearsal writes nothing');
  eq(calls.sent.length, 0, 'forced rehearsal sends nothing');

  reset();
  const after = await cutoff.runCutoff(null, { dryRun: true, now: AFTER, invites: [invite()] });
  eq(after.pastDeadline, true, 'a real post-deadline run reports pastDeadline');

  // force must never be a backdoor to an early real send.
  reset();
  const exec = await cutoff.runCutoff(null, { dryRun: false, now: BEFORE, invites: [invite()] });
  eq(exec.refused, 'before_deadline', 'execute without force is still refused early');
}

async function testDryRunIsInert() {
  reset();
  const r = await cutoff.runCutoff(null, {
    dryRun: true,
    now: AFTER,
    invites: [invite(), invite({ inviteId: 'inv2', phoneNorm: '+15551230001' })]
  });
  eq(r.dryRun, true, 'dry run reports itself');
  eq(r.declined, 2, 'dry run counts both households');
  eq(r.texted, 2, 'dry run counts both texts');
  eq(calls.markResponded.length, 0, 'dry run writes nothing');
  eq(calls.sent.length, 0, 'dry run sends nothing');
  eq(calls.events.length, 0, 'dry run logs no events');
  ok(r.textedRows[0].segments >= 1, 'dry run reports real segment counts');

  // The preview is rendered in a browser, so the body it carries must not be
  // a working magic link -- an open devtools window would otherwise hand over
  // credentials to someone else's RSVP.
  const preview = r.textedRows[0].bodyPreview;
  ok(typeof preview === 'string' && preview.length > 0, 'dry run carries a body preview for the admin page');
  ok(preview.includes('?t=<redacted>'), 'the preview redacts the magic token');
  ok(!/\?t=[A-Za-z0-9._-]{8,}/.test(preview), 'no live token survives in the preview');

  reset();
  const d = await cutoff.runCutoff(null, { now: AFTER, invites: [invite()] });
  eq(d.dryRun, true, 'omitting dryRun defaults to a dry run');
  eq(calls.sent.length, 0, 'default run sends nothing');
}

async function testExecute() {
  reset();
  const invites = [
    invite({ inviteId: 'a', phoneNorm: '+15550001' }),
    invite({ inviteId: 'b', phoneNorm: '', primaryLastName: 'NoPhone' }),
    invite({ inviteId: 'c', phoneNorm: '+15550003', optedOutOfSms: true }),
    invite({ inviteId: 'd', phoneNorm: '+15550004', smsHardFailedAt: '2026-01-01' }),
    invite({ inviteId: 'e', responded: true }),
    invite({ inviteId: 'f', phoneNorm: '+15550006', locale: 'es' })
  ];
  const r = await cutoff.runCutoff(null, { dryRun: false, now: AFTER, invites });

  eq(r.declined, 5, 'execute declines every outstanding household');
  eq(r.texted, 2, 'execute texts only the reachable ones');
  eq(calls.markResponded.length, 5, 'execute wrote five declines');
  eq(calls.sent.length, 2, 'execute sent exactly two texts');
  eq(calls.sent.map((s) => s.to).sort().join(','), '+15550001,+15550006',
    'opted-out / hard-failed / phoneless were NOT texted');

  const optedOut = calls.markResponded.find((m) => m.inviteId === 'c');
  ok(!!optedOut, 'opted-out household is still recorded as declined');
  ok(!!optedOut.opts.autoDeclinedAt, 'decline is stamped autoDeclinedAt');
  eq(optedOut.opts.late, true, 'decline is flagged late');

  const es = calls.markResponded.find((m) => m.inviteId === 'f');
  eq(es.opts.keepLocale, true, 'sweep asks storage to keep the locale');
  eq(es.opts.locale, 'es', 'Spanish invite keeps its locale');

  // A leaked audit log plus a leaked signing secret must not add up to a
  // replayable link into someone else's RSVP.
  const logged = calls.smsLog.find((l) => l.inviteId === 'a');
  ok(logged.entry.body.includes('<redacted>'), 'audit log redacts the magic token');
  ok(!/\?t=[A-Za-z0-9]/.test(logged.entry.body), 'audit log carries no live token');
  eq(logged.entry.type, 'auto_decline', 'audit row is typed auto_decline');

  ok(calls.events.some((e) => e.type === 'cron.rsvp_cutoff_run'), 'run-level event written');
  eq(calls.events.filter((e) => e.type === 'rsvp.auto_declined').length, 5, 'per-household events written');
}

async function testSharedHandset() {
  reset();
  const r = await cutoff.runCutoff(null, {
    dryRun: false,
    now: AFTER,
    invites: [
      invite({ inviteId: 'h1', phoneNorm: '+15559999', primaryLastName: 'One' }),
      invite({ inviteId: 'h2', phoneNorm: '+15559999', primaryLastName: 'Two' })
    ]
  });
  eq(r.declined, 2, 'both households on one handset are declined');
  eq(calls.sent.length, 1, 'but the handset only gets one text');
  eq(r.skipped.not_texted_dup_phone, 1, 'the duplicate is reported');
}

async function testIdempotent() {
  reset();
  // Second run sees exactly what the first run produced: everything responded.
  const r = await cutoff.runCutoff(null, {
    dryRun: false,
    now: AFTER,
    invites: [invite({ inviteId: 'a', responded: true }), invite({ inviteId: 'b', responded: true })]
  });
  eq(r.declined, 0, 're-run declines nobody');
  eq(calls.sent.length, 0, 're-run texts nobody');
  eq(r.skipped.already_responded, 2, 're-run reports them as already responded');
}

async function testSendFailure() {
  reset();
  sendBehavior = () => ({ successful: false, deliveryStatus: 'failed', errorCode: '30003', errorMessage: 'unreachable' });
  const r = await cutoff.runCutoff(null, {
    dryRun: false,
    now: AFTER,
    invites: [invite({ inviteId: 'z', phoneNorm: '+15557777' })]
  });
  eq(r.declined, 1, 'send failure does not roll back the decline');
  eq(r.texted, 0, 'send failure is not counted as texted');
  eq(r.sendFailed, 1, 'send failure is surfaced');
  eq(r.sendFailedRows[0].errorCode, '30003', 'send failure carries the error code');
  ok(calls.patched.some((p) => p.patch.smsHardFailedAt), 'permanent failure marks the invite hard-failed');
}

// --- endpoint guards -------------------------------------------------------
// The rails that stand between a stray HTTP call and texting the entire guest
// list. Stub auth/cutoff/notify so we observe exactly which dryRun value the
// handler would hand the sweep.
function loadHandlerWithStubs() {
  const authPath = require.resolve('../api/_lib/auth');
  const cutoffPath = require.resolve('../api/_lib/cutoff');
  const notifyPath = require.resolve('../api/_lib/notify');
  const handlerPath = require.resolve('../api/cron_rsvp_cutoff');

  const seen = { runs: [] };
  const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

  stub(authPath, { verifyCronSecret: (req) => (req.headers || {})['x-cron-secret'] === 'good' });
  stub(cutoffPath, {
    runCutoff: async (ctx, opts) => { seen.runs.push(opts); return { ok: true, dryRun: opts.dryRun, declined: 0, texted: 0, skipped: {} }; }
  });
  stub(notifyPath, { emailAdminsOfCutoffSummary: async () => {} });

  delete require.cache[handlerPath];
  const handler = require(handlerPath);
  return { handler, seen };
}

async function testEndpointGuards() {
  const { handler, seen } = loadHandlerWithStubs();
  const call = async (body, headers) => {
    const ctx = { log: Object.assign(() => {}, { error: () => {} }), res: null };
    await handler(ctx, { headers: headers || { 'x-cron-secret': 'good' }, body, query: {} });
    return ctx.res;
  };
  // Never index straight into seen.runs -- if a regression stops the sweep
  // being reached at all, we want a readable FAIL, not a TypeError.
  const lastRun = () => seen.runs[seen.runs.length - 1] || {};

  eq((await call({}, { 'x-cron-secret': 'bad' })).status, 401, 'bad cron secret -> 401');
  eq(seen.runs.length, 0, 'bad cron secret never reaches the sweep');

  let res = await call({});
  eq(res.status, 200, 'no flags -> 200');
  eq(lastRun().dryRun, true, 'no flags -> dry run (default-deny)');

  res = await call({ dryRun: true });
  eq(lastRun().dryRun, true, 'dryRun=true -> dry run');

  const before = seen.runs.length;
  res = await call({ dryRun: false });
  eq(res.status, 400, 'execute without the confirm phrase -> 400');
  eq(res.body.error, 'confirm_required', 'execute without confirm names the reason');
  eq(seen.runs.length, before, 'execute without confirm never reaches the sweep');

  res = await call({ dryRun: false, confirm: 'decline-outstanding' });
  eq(res.status, 400, 'confirm phrase is case-sensitive');

  res = await call({ dryRun: false, confirm: 'DECLINE-OUTSTANDING' });
  eq(res.status, 200, 'dryRun=false + correct confirm -> 200');
  eq(lastRun().dryRun, false, 'only the fully-confirmed call executes');
}

// --- admin endpoint guards -------------------------------------------------
// The admin twin of the cron endpoint. Its distinguishing property is the
// ASYMMETRIC force flag: a preview forces past the date gate so the host can
// rehearse today, while an execute never does -- so no sequence of browser
// clicks can auto-decline the guest list before the deadline.
function loadAdminHandlerWithStubs() {
  const corsPath = require.resolve('../api/_lib/cors');
  const authPath = require.resolve('../api/_lib/auth');
  const storagePath = require.resolve('../api/_lib/storage');
  const cutoffPath = require.resolve('../api/_lib/cutoff');
  const notifyPath = require.resolve('../api/_lib/notify');
  const handlerPath = require.resolve('../api/admin_rsvp_cutoff');

  const seen = { runs: [], digests: 0 };
  const stub = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

  stub(corsPath, {
    preflight: () => ({ handled: false, cors: {}, origin: 'https://johnanddianaswedding.com' }),
    isAllowedOrigin: (o) => o === 'https://johnanddianaswedding.com'
  });
  stub(authPath, {
    isAdmin: (req) => (req.headers || {})['x-admin'] === 'yes',
    readAdminActor: () => 'admin:host@example.com'
  });
  stub(storagePath, { ensureTables: async () => {} });
  stub(cutoffPath, {
    runCutoff: async (ctx, opts) => { seen.runs.push(opts); return { ok: true, dryRun: opts.dryRun, declined: 0, texted: 0, skipped: {} }; }
  });
  stub(notifyPath, { emailAdminsOfCutoffSummary: async () => { seen.digests += 1; } });

  delete require.cache[handlerPath];
  const handler = require(handlerPath);
  return { handler, seen };
}

async function testAdminEndpointGuards() {
  const { handler, seen } = loadAdminHandlerWithStubs();
  const call = async (body, headers) => {
    const ctx = { log: Object.assign(() => {}, { error: () => {} }), res: null };
    await handler(ctx, {
      method: 'POST',
      headers: Object.assign({ 'x-admin': 'yes' }, headers || {}),
      body
    });
    return ctx.res;
  };
  const lastRun = () => seen.runs[seen.runs.length - 1] || {};

  eq((await call({}, { 'x-admin': 'no' })).status, 403, 'non-admin -> 403');
  eq((await call({}, { 'x-admin': 'no' })).body.error, 'admin_required', 'non-admin names the reason');
  eq(seen.runs.length, 0, 'non-admin never reaches the sweep');

  let res = await call({});
  eq(res.status, 200, 'admin preview -> 200');
  eq(lastRun().dryRun, true, 'empty body -> dry run (default-deny)');
  eq(lastRun().force, true, 'a preview forces past the date gate so it can be rehearsed early');
  eq(lastRun().actor, 'admin:host@example.com', 'the audit actor is the admin, not cron');
  eq(seen.digests, 0, 'a preview does not email the digest');

  let before = seen.runs.length;
  res = await call({ dryRun: false });
  eq(res.status, 400, 'execute without the confirm phrase -> 400');
  eq(res.body.error, 'confirm_required', 'execute without confirm names the reason');
  eq(seen.runs.length, before, 'execute without confirm never reaches the sweep');

  before = seen.runs.length;
  res = await call({ dryRun: false, confirm: 'decline-outstanding' });
  eq(res.status, 400, 'confirm phrase is case-sensitive');
  eq(seen.runs.length, before, 'wrong-case confirm never reaches the sweep');

  res = await call({ dryRun: false, confirm: 'DECLINE-OUTSTANDING' });
  eq(res.status, 200, 'admin execute with the confirm phrase -> 200');
  eq(lastRun().dryRun, false, 'only the fully-confirmed call executes');
  eq(lastRun().force, false, 'an execute NEVER forces -- the browser gets no early-send override');
  eq(seen.digests, 1, 'a real run emails the digest');
}

async function main() {
  testBuildPayload();
  testPlan();
  testCopy();
  await testRefusesBeforeDeadline();
  await testForcedPreDeadlineDryRun();
  await testDryRunIsInert();
  await testExecute();
  await testSharedHandset();
  await testIdempotent();
  await testSendFailure();
  await testEndpointGuards();
  await testAdminEndpointGuards();

  console.log('rsvp-cutoff:', count - fails, '/', count, 'passed');
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error('rsvp-cutoff: harness threw', err);
  process.exit(1);
});
