// One-shot smoke test: load local.settings.json env vars and fire a test SMS
// via the unified sms.js abstraction. Run from repo root:
//   node scripts/smoke-sms.cjs +15169930602
// Deletes itself out of the repo's mental model — not committed; gitignored
// via *.local-only.cjs if you want, but for now: throw it away when done.

'use strict';

const path = require('path');
const fs = require('fs');

const settingsPath = path.join(__dirname, '..', 'api', 'local.settings.json');
if (!fs.existsSync(settingsPath)) {
  console.error('Missing api/local.settings.json');
  process.exit(2);
}
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (process.env[k] == null) process.env[k] = String(v);
}

const dest = process.argv[2];
if (!dest || !/^\+\d{10,15}$/.test(dest)) {
  console.error('Usage: node scripts/smoke-sms.cjs +1XXXXXXXXXX');
  process.exit(2);
}

const sms = require(path.join(__dirname, '..', 'api', '_lib', 'sms.js'));

const body = 'Test from John & Diana wedding RSVP system via Twilio. If you got this, the dev pipeline works. Reply STOP to opt out.';

(async () => {
  console.log(`provider=${process.env.SMS_PROVIDER || 'acs'} from=${process.env.TWILIO_FROM || process.env.ACS_SMS_FROM} to=${dest}`);
  const result = await sms.sendSms(dest, body, { tag: 'smoke' });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.successful ? 0 : 1);
})();
