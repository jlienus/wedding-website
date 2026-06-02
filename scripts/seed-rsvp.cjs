#!/usr/bin/env node
'use strict';

// Seed the RSVP storage with starter invitations and (optionally) drop the
// obsolete v1 tables (rsvpParties, rsvpMembers, rsvpResponses).
//
// Usage:
//   $env:RSVP_STORAGE_CONNECTION = "<full connection string>"
//   node scripts/seed-rsvp.cjs [--reset] [--phone +15551234567] [--drop-old] [--dry-run]
//
// Flags:
//   --reset           Delete the seeded invite (i_johndiana) before re-inserting.
//                     Does NOT touch real invites you've created via the admin UI.
//   --phone <E.164>   Phone number to put on the John & Diana invite. Otherwise
//                     uses a clearly-fake placeholder.
//   --drop-old        After seeding, drop the obsolete v1 tables. Idempotent —
//                     a no-op if they were already dropped.
//   --dry-run         Don't write anything; just print what would happen.

const path = require('path');
const Module = require('module');

const apiRoot = path.resolve(__dirname, '..', 'api');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('./_lib/') || request.startsWith('../_lib/')) {
    const rebased = path.resolve(apiRoot, request.replace(/^\.\.?\/_lib\//, '_lib/'));
    return originalResolve.call(this, rebased, parent, ...rest);
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const storage = require(path.join(apiRoot, '_lib', 'storage'));
const auth = require(path.join(apiRoot, '_lib', 'auth'));
const { emptyPayload } = require(path.join(apiRoot, '_lib', 'payload'));

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const DROP_OLD = args.includes('--drop-old');
const DRY_RUN = args.includes('--dry-run');
const phoneFlagIdx = args.indexOf('--phone');
const JOHN_PHONE = (phoneFlagIdx >= 0 && args[phoneFlagIdx + 1]) || '+15555550100';

if (!process.env.RSVP_STORAGE_CONNECTION) {
  console.error('ERROR: RSVP_STORAGE_CONNECTION env var is required.');
  console.error('  Get it from the Azure portal -> Storage account -> Access keys -> Connection string.');
  process.exit(1);
}
if (!process.env.RSVP_MAGIC_SECRET) {
  process.env.RSVP_MAGIC_SECRET = 'seed-script-placeholder-secret-not-used-anywhere-32+chars-aaa';
}

const SEED_INVITES = [
  {
    inviteId: 'i_johndiana',
    primaryFirstName: 'John',
    primaryLastName: 'Lien',
    phone: JOHN_PHONE,
    locale: 'en',
    adminNotes: 'The couple themselves (test invitation). Diana can be added as an additional guest via the form.'
  }
];

async function run() {
  console.log(`Seed-rsvp v2 — invites table. dryRun=${DRY_RUN} reset=${RESET} dropOld=${DROP_OLD}`);
  console.log('');

  console.log('Ensuring tables exist…');
  if (!DRY_RUN) await storage.ensureTables();
  console.log('  OK.\n');

  if (RESET) {
    for (const seed of SEED_INVITES) {
      console.log(`Resetting invite ${seed.inviteId} (${seed.primaryFirstName} ${seed.primaryLastName})…`);
      if (!DRY_RUN) {
        try {
          const r = await storage.deleteInvite(seed.inviteId);
          console.log(`  deleted invite + ${r.smsRowsDeleted || 0} SMS log row(s).`);
        } catch (err) {
          console.warn(`  warn: ${err && err.message}`);
        }
      }
    }
    console.log('');
  }

  for (const seed of SEED_INVITES) {
    console.log(`Seeding invite ${seed.inviteId} (${seed.primaryFirstName} ${seed.primaryLastName})`);
    const invite = {
      inviteId: seed.inviteId,
      primaryFirstName: seed.primaryFirstName,
      primaryLastName: seed.primaryLastName,
      phone: seed.phone,
      locale: seed.locale,
      adminNotes: seed.adminNotes,
      payload: emptyPayload(),
      responded: false,
      respondedAt: '',
      respondedLate: false,
      optedOutOfSms: false,
      smsHardFailedAt: '',
      lastReminderSentAt: '',
      reminderCount: 0
    };
    if (!DRY_RUN) await storage.upsertInvite(invite);
    console.log(`  phone=${seed.phone || '(none)'} locale=${seed.locale}`);
    console.log('');
  }

  if (DROP_OLD) {
    console.log('Dropping obsolete v1 tables (rsvpParties, rsvpMembers, rsvpResponses)…');
    if (!DRY_RUN) {
      try {
        const dropped = await storage.dropObsoleteTables();
        for (const [name, r] of Object.entries(dropped)) {
          if (r.dropped) {
            console.log(`  ${name}: dropped`);
          } else if (r.reason === 'not_found') {
            console.log(`  ${name}: skipped (already gone)`);
          } else if (r.error) {
            console.log(`  ${name}: error (${r.error})`);
          } else {
            console.log(`  ${name}: skipped`);
          }
        }
      } catch (err) {
        console.warn(`  warn: ${err && err.message}`);
      }
    } else {
      console.log('  (skipped: --dry-run)');
    }
    console.log('');
  }

  if (!DRY_RUN) {
    const settings = await storage.getSettings();
    console.log('Current settings:');
    console.log(`  remindersEnabled: ${settings.remindersEnabled}`);
    console.log(`  remindersStopOnUtc: ${settings.remindersStopOnUtc}`);
    console.log('');

    console.log('Done. Try the form at /rsvp with name "John Lien".');
    try {
      const token = auth.signMagicToken('i_johndiana');
      console.log(`Magic-link token for i_johndiana: ${token}`);
      console.log('  (use as /api/rsvp/magic?t=<token>)');
    } catch (err) {
      console.log(`  (set RSVP_MAGIC_SECRET to generate a real token; got ${err && err.message})`);
    }
  } else {
    console.log('Dry-run complete. Re-run without --dry-run to actually write.');
  }
}

run().catch((err) => {
  console.error('SEED FAILED:', err && err.message);
  if (err && err.stack) console.error(err.stack);
  process.exit(2);
});
