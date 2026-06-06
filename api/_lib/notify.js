'use strict';

// Admin-facing transactional notifications.
//
// Currently exports a single sender, notifyAdminsOfRsvpUpdate, that emails
// every address on ADMIN_EMAIL_ALLOWLIST whenever a guest submits or updates
// an RSVP. The rsvp_submit handler calls this AFTER the public 200 has been
// composed but before the function returns, so failures here can never
// affect the guest-facing response.
//
// Design notes:
//   * Best-effort. Every failure path is caught and logged via context +
//     storage.appendEvent. We never throw to the caller.
//   * Kill switch. Set ADMIN_NOTIFY_RSVP=false (or 0) to disable without a
//     redeploy. Useful during a bulk-import or batch-replay event when
//     thousands of submits would otherwise blast the admin inbox.
//   * Latency. We reuse the same ACS Email path as admin_login_request,
//     which returns as soon as the long-running send is ACCEPTED (typically
//     200-500 ms). With a 1-5 entry allowlist and Promise.all fan-out,
//     total added latency on rsvp_submit stays well under a second.
//   * PII. The notification body contains guest names and meal choices.
//     Recipients are the same admin email addresses that already see the
//     full RSVP dataset via the admin dashboard -- no new disclosure surface.
//     Phone numbers are NOT included (they live encrypted-at-rest and are
//     not needed for "someone responded" awareness).

const auth = require('./auth');
const email = require('./email');
const storage = require('./storage');

const SITE_ORIGIN = process.env.RSVP_SITE_ORIGIN || 'https://johnanddianaswedding.com';

// Choice-key -> human-readable label for the menu. Mirrors the canonical
// keys in payload.js so we don't import the entire payload module just for
// label lookup, and so admins always see the English course names regardless
// of guest locale.
const MENU_LABELS = {
  entradaChoice: {
    salpicon: 'Seafood salpicón',
    hojaldre: 'Beef puff pastry',
    causa: 'Causa limeña'
  },
  sorbetChoice: {
    maracuya: 'Passion-fruit sorbet',
    mandarina: 'Mandarin-mint sorbet'
  },
  mealChoice: {
    chicken: 'Chicken cordon bleu',
    beef: 'Beef tenderloin'
  },
  postreChoice: {
    chocolate: 'Chocolate dome',
    cheesecake: 'Red-berry cheesecake',
    tiramisu: 'Classic tiramisú'
  }
};

const COURSE_ORDER = ['entradaChoice', 'sorbetChoice', 'mealChoice', 'postreChoice'];

function isNotifyEnabled() {
  const raw = (process.env.ADMIN_NOTIFY_RSVP || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  return true;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function householdName(invite) {
  const first = (invite && invite.primaryFirstName) || '';
  const last = (invite && invite.primaryLastName) || '';
  const joined = `${first} ${last}`.trim();
  return joined || (invite && invite.inviteId) || 'Unknown invite';
}

function describeAttending(a) {
  if (a === true) return 'Yes';
  if (a === false) return 'No';
  return 'TBD';
}

function describeCourses(attendee) {
  if (attendee.attending !== true) return '';
  const parts = [];
  for (const key of COURSE_ORDER) {
    const value = attendee[key];
    if (!value) continue;
    const label = (MENU_LABELS[key] && MENU_LABELS[key][value]) || value;
    parts.push(label);
  }
  return parts.join(' · ');
}

function buildAttendeeRowsHtml(payload) {
  const rows = [];
  const all = [];
  if (payload && payload.primary) {
    all.push({
      name: 'Primary invitee',
      attendee: payload.primary,
      isPrimary: true
    });
  }
  if (payload && Array.isArray(payload.additionalGuests)) {
    for (const g of payload.additionalGuests) {
      all.push({
        name: g.name || '(unnamed guest)',
        attendee: g,
        isPrimary: false,
        isKid: !!g.isKid
      });
    }
  }
  for (const entry of all) {
    const a = entry.attendee || {};
    const attending = describeAttending(a.attending);
    const courses = describeCourses(a);
    const dietary = a.dietary ? `<div style="font-size:13px;color:#555;margin-top:2px;">Dietary: ${escapeHtml(a.dietary)}</div>` : '';
    const song = a.songRequest ? `<div style="font-size:13px;color:#555;margin-top:2px;">Song: ${escapeHtml(a.songRequest)}</div>` : '';
    const kidTag = entry.isKid ? ' <span style="font-size:11px;color:#8a6a2c;letter-spacing:0.06em;text-transform:uppercase;">kid</span>' : '';
    const courseLine = courses ? `<div style="font-size:13px;color:#333;margin-top:2px;">${escapeHtml(courses)}</div>` : '';
    rows.push([
      '<tr>',
      `<td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;"><strong>${escapeHtml(entry.name)}</strong>${kidTag}</td>`,
      `<td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;">${escapeHtml(attending)}</td>`,
      `<td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;">${courseLine}${dietary}${song}</td>`,
      '</tr>'
    ].join(''));
  }
  return rows.join('');
}

function buildAttendeeLinesText(payload) {
  const lines = [];
  const push = (label, a, opts) => {
    const tag = opts && opts.isKid ? ' [kid]' : '';
    const attending = describeAttending(a.attending);
    const courses = describeCourses(a);
    const extras = [];
    if (courses) extras.push(courses);
    if (a.dietary) extras.push(`dietary: ${a.dietary}`);
    if (a.songRequest) extras.push(`song: ${a.songRequest}`);
    const extra = extras.length ? ` -- ${extras.join('; ')}` : '';
    lines.push(`  - ${label}${tag}: ${attending}${extra}`);
  };
  if (payload && payload.primary) {
    push('Primary invitee', payload.primary);
  }
  if (payload && Array.isArray(payload.additionalGuests)) {
    for (const g of payload.additionalGuests) {
      push(g.name || '(unnamed guest)', g, { isKid: !!g.isKid });
    }
  }
  return lines.join('\n');
}

function summaryText(summary) {
  const bits = [];
  if (summary.yes) bits.push(`${summary.yes} yes`);
  if (summary.no) bits.push(`${summary.no} no`);
  if (summary.pending) bits.push(`${summary.pending} TBD`);
  if (summary.kids) bits.push(`${summary.kids} kid${summary.kids === 1 ? '' : 's'}`);
  return bits.length ? bits.join(' · ') : 'no responses yet';
}

function subjectFor(isUpdate, household, summary, late) {
  const prefix = isUpdate ? 'RSVP updated' : 'RSVP received';
  const lateTag = late ? ' [LATE]' : '';
  return `${prefix}: ${household} (${summaryText(summary)})${lateTag}`;
}

function buildHtml({ household, isUpdate, summary, payload, late, receivedAt, notes }) {
  const verb = isUpdate ? 'updated their RSVP' : 'submitted an RSVP';
  const lateBanner = late
    ? '<p style="margin:0 0 16px;padding:8px 12px;background:#fff4d6;border-left:4px solid #c9a961;font-size:14px;color:#5a4318;">Submitted after the guest-deadline window.</p>'
    : '';
  const notesBlock = notes
    ? `<h3 style="margin:24px 0 6px;font-size:15px;color:#8a6a2c;font-weight:600;">Notes from the household</h3><p style="margin:0;padding:8px 12px;background:#fcfbf6;border:1px solid #e8e0c8;border-radius:6px;font-size:14px;color:#333;white-space:pre-wrap;">${escapeHtml(notes)}</p>`
    : '';
  const adminLink = `${SITE_ORIGIN}/admin`;
  return [
    '<!doctype html>',
    '<html><body style="font-family:Georgia,serif;max-width:640px;margin:24px auto;line-height:1.5;color:#1a1a1a;padding:0 16px;">',
    `<h2 style="font-weight:400;letter-spacing:0.02em;margin:0 0 4px;">${escapeHtml(household)} ${escapeHtml(verb)}</h2>`,
    `<p style="margin:0 0 16px;color:#555;font-size:14px;">${escapeHtml(receivedAt)} &middot; ${escapeHtml(summaryText(summary))}</p>`,
    lateBanner,
    '<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px;">',
    '<thead><tr style="background:rgba(201,169,97,0.10);text-align:left;">',
    '<th style="padding:8px 10px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#8a6a2c;font-weight:600;">Guest</th>',
    '<th style="padding:8px 10px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#8a6a2c;font-weight:600;white-space:nowrap;">Attending</th>',
    '<th style="padding:8px 10px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#8a6a2c;font-weight:600;">Menu &middot; dietary &middot; song</th>',
    '</tr></thead>',
    '<tbody>',
    buildAttendeeRowsHtml(payload),
    '</tbody></table>',
    notesBlock,
    `<p style="margin:24px 0 8px;"><a href="${escapeHtml(adminLink)}" style="display:inline-block;background:#1a1a1a;color:#faf8f4;text-decoration:none;padding:10px 20px;border-radius:4px;font-size:14px;letter-spacing:0.04em;">Open the admin dashboard</a></p>`,
    '<p style="font-size:12px;color:#888;margin-top:28px;">You\'re receiving this because your email is on the admin allowlist for the John &amp; Diana RSVP system. Set <code>ADMIN_NOTIFY_RSVP=false</code> on the SWA app settings to mute these notifications.</p>',
    '</body></html>'
  ].join('');
}

function buildText({ household, isUpdate, summary, payload, late, receivedAt, notes }) {
  const verb = isUpdate ? 'updated their RSVP' : 'submitted an RSVP';
  const lines = [
    `${household} ${verb}`,
    `${receivedAt} -- ${summaryText(summary)}${late ? ' [LATE]' : ''}`,
    '',
    'Attendees:',
    buildAttendeeLinesText(payload)
  ];
  if (notes) {
    lines.push('', 'Notes from the household:', notes);
  }
  lines.push('', `Admin dashboard: ${SITE_ORIGIN}/admin`);
  lines.push('', 'Mute by setting ADMIN_NOTIFY_RSVP=false in SWA app settings.');
  return lines.join('\n');
}

// Best-effort. Never throws. Caller does not need to await -- but awaiting
// adds at most ~500ms per recipient since ACS sendEmail returns on accept,
// not on terminal delivery.
async function notifyAdminsOfRsvpUpdate(context, ctx) {
  const log = (context && context.log) || (() => {});
  const logErr = (context && context.log && context.log.error) || (() => {});

  try {
    if (!isNotifyEnabled()) {
      log('notify_rsvp skipped reason=disabled_env');
      return;
    }

    const invite = ctx && ctx.invite;
    const payload = ctx && ctx.payload;
    const summary = ctx && ctx.summary;
    if (!invite || !payload || !summary) {
      log('notify_rsvp skipped reason=missing_ctx');
      return;
    }

    let recipients = [];
    try {
      recipients = auth.getAdminEmailAllowlist();
    } catch (err) {
      logErr(`notify_rsvp skipped reason=no_allowlist: ${err && err.message}`);
      return;
    }
    if (!recipients.length) {
      log('notify_rsvp skipped reason=empty_allowlist');
      return;
    }

    const household = householdName(invite);
    const isUpdate = !!ctx.isUpdate;
    const late = !!ctx.late;
    const receivedAt = ctx.receivedAt || new Date().toISOString();
    const notes = (payload.primary && payload.primary.notes) || '';
    const subject = subjectFor(isUpdate, household, summary, late);
    const html = buildHtml({ household, isUpdate, summary, payload, late, receivedAt, notes });
    const plainText = buildText({ household, isUpdate, summary, payload, late, receivedAt, notes });

    const results = await Promise.all(recipients.map(async (to) => {
      try {
        const r = await email.sendEmail({ to, subject, html, plainText });
        return { to, ok: !!r.successful, messageId: r.messageId, status: r.status, errorCode: r.errorCode, errorMessage: r.errorMessage };
      } catch (err) {
        return { to, ok: false, status: 'exception', errorCode: (err && err.code) || 'EXCEPTION', errorMessage: (err && err.message) || String(err) };
      }
    }));

    const successCount = results.filter((r) => r.ok).length;
    const failureCount = results.length - successCount;

    log(`notify_rsvp inviteId=${invite.inviteId} recipients=${recipients.length} ok=${successCount} fail=${failureCount} isUpdate=${isUpdate} late=${late}`);

    try {
      await storage.appendEvent({
        type: 'admin.notify.rsvp_submitted',
        actor: `system:rsvp_submit`,
        summary: `Notified ${successCount}/${results.length} admin(s) of ${household}'s ${isUpdate ? 'updated' : 'new'} RSVP`,
        meta: {
          inviteId: invite.inviteId,
          recipientCount: results.length,
          successCount,
          failureCount,
          isUpdate,
          late,
          messageIds: results.filter((r) => r.ok && r.messageId).map((r) => r.messageId)
        }
      });
    } catch (err) { logErr(`notify_rsvp event_write_failed: ${err && err.message}`); }

    for (const r of results) {
      if (r.ok) continue;
      try {
        await storage.appendEvent({
          type: 'admin.notify.rsvp_send_failed',
          actor: `system:rsvp_submit`,
          summary: `Failed to notify admin (${r.errorCode || r.status || 'unknown'}) for ${household}`,
          meta: {
            inviteId: invite.inviteId,
            recipientHash: hashRecipient(r.to),
            status: r.status,
            errorCode: r.errorCode,
            errorMessage: r.errorMessage
          }
        });
      } catch (err) { logErr(`notify_rsvp fail_event_write_failed: ${err && err.message}`); }
    }
  } catch (err) {
    logErr(`notify_rsvp unexpected_failure: ${err && err.message}`);
  }
}

function hashRecipient(email) {
  // We log the hash of the recipient rather than the address itself so the
  // audit log doesn't carry plaintext admin emails. Same shape used by
  // admin_login_request's emailKey helper.
  try {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(`admin-notify|${String(email).toLowerCase()}`).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

module.exports = { notifyAdminsOfRsvpUpdate };
