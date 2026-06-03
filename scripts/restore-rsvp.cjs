#!/usr/bin/env node
'use strict';

// scripts/restore-rsvp.cjs — restore an RSVP backup snapshot into Table Storage.
//
// Usage:
//   $env:RSVP_STORAGE_CONNECTION = '<connection-string>'
//   node scripts/restore-rsvp.cjs path/to/rsvp-2027-06-03T07-00-00Z.json [--dry-run] [--only=invites,events,settings,smslog]
//
// The script is idempotent — entities are upserted by (PartitionKey, RowKey),
// so re-running with the same backup is safe. By default it restores all four
// tables; use --only to scope.
//
// IMPORTANT: this is a destructive operation on production data if you point
// it at the live storage account. Always --dry-run first, and consider
// restoring into a staging account before touching production.

const fs = require('fs');
const path = require('path');
const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');

function parseConnectionString(cs) {
  const parts = {};
  for (const seg of cs.split(';')) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  if (!parts.AccountName || !parts.AccountKey) throw new Error('Bad connection string');
  const endpoint = parts.TableEndpoint
    || `https://${parts.AccountName}.table.${parts.EndpointSuffix || 'core.windows.net'}`;
  return { name: parts.AccountName, key: parts.AccountKey, endpoint };
}

function parseArgs(argv) {
  const out = { file: null, dryRun: false, only: null };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--only=')) out.only = new Set(a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean));
    else if (!out.file && !a.startsWith('--')) out.file = a;
  }
  return out;
}

async function upsertBatch(client, label, entities, { dryRun }) {
  let ok = 0;
  let failed = 0;
  for (const e of entities) {
    if (!e || !e.partitionKey || !e.rowKey) {
      console.error(`  skip ${label}: missing PK/RK on entity`);
      failed += 1;
      continue;
    }
    if (dryRun) { ok += 1; continue; }
    try {
      await client.upsertEntity(e, 'Replace');
      ok += 1;
    } catch (err) {
      console.error(`  fail ${label} ${e.partitionKey}/${e.rowKey}: ${err && err.message}`);
      failed += 1;
    }
  }
  console.log(`  ${label}: ${ok} ok, ${failed} failed${dryRun ? ' (dry-run)' : ''}`);
  return { ok, failed };
}

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Usage: node scripts/restore-rsvp.cjs <backup.json> [--dry-run] [--only=invites,events,settings,smslog]');
    process.exit(2);
  }
  const cs = process.env.RSVP_STORAGE_CONNECTION;
  if (!cs) {
    console.error('RSVP_STORAGE_CONNECTION env var is required');
    process.exit(2);
  }
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(`backup file not found: ${filePath}`);
    process.exit(2);
  }
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`failed to parse backup JSON: ${err && err.message}`);
    process.exit(2);
  }
  if (!snap || typeof snap !== 'object' || snap.schemaVersion !== 1) {
    console.error(`unrecognized backup schemaVersion: ${snap && snap.schemaVersion}`);
    process.exit(2);
  }

  const { name, key, endpoint } = parseConnectionString(cs);
  const cred = new AzureNamedKeyCredential(name, key);
  const make = (t) => new TableClient(endpoint, t, cred);

  console.log(`Restoring from ${filePath}`);
  console.log(`  taken at: ${snap.takenAt}`);
  console.log(`  storage:  ${name} (${endpoint})`);
  console.log(`  mode:     ${args.dryRun ? 'DRY RUN — no writes' : 'WRITE'}`);
  console.log('');

  const want = (label) => !args.only || args.only.has(label);
  const totals = { ok: 0, failed: 0 };

  if (want('invites') && Array.isArray(snap.invites)) {
    console.log(`rsvpInvites (${snap.invites.length} rows)`);
    const r = await upsertBatch(make('rsvpInvites'), 'rsvpInvites', snap.invites, args);
    totals.ok += r.ok; totals.failed += r.failed;
  }
  if (want('events') && Array.isArray(snap.events)) {
    console.log(`rsvpEvents (${snap.events.length} rows)`);
    const r = await upsertBatch(make('rsvpEvents'), 'rsvpEvents', snap.events, args);
    totals.ok += r.ok; totals.failed += r.failed;
  }
  if (want('settings') && Array.isArray(snap.settings)) {
    console.log(`rsvpSettings (${snap.settings.length} rows)`);
    const r = await upsertBatch(make('rsvpSettings'), 'rsvpSettings', snap.settings, args);
    totals.ok += r.ok; totals.failed += r.failed;
  }
  if (want('smslog') && Array.isArray(snap.smslog)) {
    console.log(`rsvpSmsLog (${snap.smslog.length} rows)`);
    const r = await upsertBatch(make('rsvpSmsLog'), 'rsvpSmsLog', snap.smslog, args);
    totals.ok += r.ok; totals.failed += r.failed;
  }

  console.log('');
  console.log(`Total: ${totals.ok} ok, ${totals.failed} failed`);
  process.exit(totals.failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('fatal:', err && err.stack || err);
  process.exit(1);
});
