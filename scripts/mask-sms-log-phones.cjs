'use strict';

// mask-sms-log-phones.cjs -- one-time (idempotent) sweep that replaces the
// full phone number in every existing rsvpSmsLog row with the same last-4
// mask new writes use (`***1234`). Re-runnable safely; already-masked rows
// are skipped.
//
// Threat covered: rsvpSmsLog leaks separately (e.g. ad-hoc export, App
// Insights misconfig, dev machine snapshot). The matching invite-table
// phone is encrypted, so masking the log too removes the last plaintext
// copy of the number from the data plane while keeping the log
// human-readable for "did this invite get the right SMS?" debugging.
//
// Required env:
//   RSVP_STORAGE_CONNECTION    full Azure Storage connection string
// Optional flags:
//   --dry-run                  print intended changes; no writes
//   --verbose                  one line per row

const storage = require('../api/_lib/storage');

const DRY = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

(async function main() {
  if (!process.env.RSVP_STORAGE_CONNECTION) {
    console.error('CONFIG_MISSING_RSVP_STORAGE_CONNECTION');
    process.exit(2);
  }
  await storage.ensureTables();
  const { smslog } = storage.getClients();

  let scanned = 0;
  let masked  = 0;
  let already = 0;
  let empty   = 0;
  let errors  = 0;

  console.log(`mask-sms-log-phones (${DRY ? 'DRY RUN' : 'LIVE'})`);
  console.log('----------------------------------');

  for await (const e of smslog.listEntities()) {
    scanned += 1;
    const before = (e.toPhone == null) ? '' : String(e.toPhone);
    const after = storage.maskPhone(before);

    if (before === '' || after === '') {
      empty += 1;
      if (VERBOSE) console.log(`  EMPTY  ${e.partitionKey}/${e.rowKey}`);
      continue;
    }
    if (before === after) {
      already += 1;
      if (VERBOSE) console.log(`  SKIP   ${e.partitionKey}/${e.rowKey}  (already masked: ${after})`);
      continue;
    }

    if (DRY) {
      masked += 1;
      console.log(`  WOULD  ${e.partitionKey}/${e.rowKey}  -> ${after}`);
      continue;
    }

    try {
      await smslog.updateEntity({
        partitionKey: e.partitionKey,
        rowKey: e.rowKey,
        toPhone: after
      }, 'Merge');
      masked += 1;
      if (VERBOSE) console.log(`  MASK   ${e.partitionKey}/${e.rowKey}  -> ${after}`);
    } catch (err) {
      errors += 1;
      console.error(`  ERR    ${e.partitionKey}/${e.rowKey}  ${err && err.message}`);
    }
  }

  console.log('----------------------------------');
  console.log(`Scanned:           ${scanned}`);
  console.log(`Newly masked:      ${masked}${DRY ? '  (would-be)' : ''}`);
  console.log(`Already masked:    ${already}`);
  console.log(`Empty (no phone):  ${empty}`);
  console.log(`Errors:            ${errors}`);

  if (!DRY && masked > 0) {
    try {
      await storage.appendEvent({
        type: 'admin.sms_log_mask_sweep',
        actor: 'script:mask-sms-log-phones',
        summary: `Masked ${masked} rsvpSmsLog rows (skipped ${already} already-masked + ${empty} empty)`,
        meta: { scanned, masked, already, empty, errors }
      });
    } catch (err) {
      console.warn(`  (note: failed to write audit event: ${err && err.message})`);
    }
  }

  process.exit(errors > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
