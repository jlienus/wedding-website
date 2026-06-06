// One-off diagnostic: find invite(s) by phone and print all reminder-relevant flags
// Usage: node scripts/diag-invite-by-phone.cjs +15169930602
// Requires env vars from api/local.settings.json OR fetches from prod SWA via az.

'use strict';
const path = require('path');
const fs = require('fs');

// Load local.settings.json env vars if present (won't overwrite existing).
const settingsPath = path.join(__dirname, '..', 'api', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const [k, v] of Object.entries(settings.Values || {})) {
    if (process.env[k] == null) process.env[k] = String(v);
  }
}

// Allow env injection from invoking shell (for prod-conn passing).
const phone = process.argv[2];
if (!phone) { console.error('Usage: node scripts/diag-invite-by-phone.cjs +1XXXXXXXXXX'); process.exit(2); }

if (!process.env.RSVP_STORAGE_CONNECTION) {
  console.error('RSVP_STORAGE_CONNECTION not set. Pass via env or local.settings.json.');
  process.exit(2);
}

const storage = require(path.join(__dirname, '..', 'api', '_lib', 'storage.js'));

(async () => {
  const norm = storage.normalizePhone(phone);
  console.log(`normalized phone: ${norm}`);
  const invites = await storage.findInvitesByPhoneNorm(norm);
  console.log(`found ${invites.length} invite(s) matching that phone`);
  for (const inv of invites) {
    console.log('---');
    console.log(JSON.stringify({
      inviteId: inv.inviteId,
      primaryFirstName: inv.primaryFirstName,
      primaryLastName: inv.primaryLastName,
      phoneNorm: inv.phoneNorm,
      locale: inv.locale,
      responded: inv.responded,
      respondedAt: inv.respondedAt,
      optedOutOfSms: inv.optedOutOfSms,
      smsHardFailedAt: inv.smsHardFailedAt,
      lastReminderSentAt: inv.lastReminderSentAt,
      reminderCount: inv.reminderCount
    }, null, 2));
  }
  const settings = await storage.getSettings();
  console.log('---settings---');
  console.log(JSON.stringify({
    remindersEnabled: settings.remindersEnabled,
    remindersStopOnUtc: settings.remindersStopOnUtc
  }, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
