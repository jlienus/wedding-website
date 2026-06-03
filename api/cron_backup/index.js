'use strict';

// POST /api/cron/backup — nightly RSVP backup. Triggered by GitHub Actions
// cron with an `X-Backup-Secret` header. Snapshots all four RSVP tables to a
// timestamped JSON blob in a private `backups` container, then conservatively
// prunes old snapshots (keep all <90 days; for older keep first-of-month).
//
// Threat model (be honest about scope):
//   This backup protects against accidental corruption / deletion / app bugs.
//   It does NOT protect against a compromised storage account key — an
//   attacker with the key can delete the production tables AND the backup
//   blobs. Stronger isolation (separate account, immutable retention) is a
//   later upgrade if the threat model changes.

const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const auth = require('../_lib/auth');
const storage = require('../_lib/storage');

const SCHEMA_VERSION = 1;
const BACKUP_CONTAINER = 'backups';
const BLOB_PREFIX = 'rsvp-';
const BLOB_DATE_RE = /^rsvp-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.json$/;

const RETENTION_RECENT_DAYS = 90;       // never delete blobs newer than this
const RETENTION_KEEP_PER_MONTH = 1;     // for older: keep first-of-month only

function parseConn(cs) {
  const parts = {};
  for (const seg of cs.split(';')) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  if (!parts.AccountName || !parts.AccountKey) {
    throw new Error('CONFIG_BAD_RSVP_STORAGE_CONNECTION');
  }
  const suffix = parts.EndpointSuffix || 'core.windows.net';
  return {
    name: parts.AccountName,
    key: parts.AccountKey,
    tableEndpoint: parts.TableEndpoint || `https://${parts.AccountName}.table.${suffix}`,
    blobEndpoint: parts.BlobEndpoint || `https://${parts.AccountName}.blob.${suffix}`
  };
}

// Strip Azure-internal etag / timestamp; everything else (PK, RK, all user
// columns) round-trips through the restore script via upsertEntity.
function cleanEntity(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'etag' || k === 'odata.etag') continue;
    out[k] = v;
  }
  return out;
}

async function dumpTable(client, tableName) {
  const rows = [];
  try {
    for await (const e of client.listEntities()) {
      rows.push(cleanEntity(e));
    }
  } catch (err) {
    const status = err && err.statusCode;
    const code = err && (err.code || err.errorCode || '');
    if (status === 404 || code === 'TableNotFound') return [];
    throw err;
  }
  return rows;
}

function buildBlobName(now) {
  // ISO 8601 with colons stripped (blobs don't love ":") and millis dropped.
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${BLOB_PREFIX}${iso}.json`;
}

// Returns {kept, deleted, skippedRecent} after applying retention.
// CONSERVATIVE: only operates on blob names matching the exact naming regex,
// never deletes anything <90 days old, and only deletes blobs older than one
// per calendar month.
async function applyRetention(container, now, context) {
  const cutoff = new Date(now.getTime() - RETENTION_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const byMonth = new Map(); // 'YYYY-MM' -> array of {name, date}
  let skippedRecent = 0;
  let nonMatching = 0;

  for await (const blob of container.listBlobsFlat()) {
    const m = BLOB_DATE_RE.exec(blob.name);
    if (!m) { nonMatching += 1; continue; }
    const [, y, mo, d, hh, mm, ss] = m;
    const date = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
    if (Number.isNaN(date.getTime())) { nonMatching += 1; continue; }
    if (date >= cutoff) { skippedRecent += 1; continue; }
    const monthKey = `${y}-${mo}`;
    if (!byMonth.has(monthKey)) byMonth.set(monthKey, []);
    byMonth.get(monthKey).push({ name: blob.name, date });
  }

  let kept = skippedRecent;
  let deleted = 0;
  for (const list of byMonth.values()) {
    list.sort((a, b) => a.date - b.date); // ascending; keep earliest
    for (let i = 0; i < list.length; i += 1) {
      if (i < RETENTION_KEEP_PER_MONTH) {
        kept += 1;
      } else {
        try {
          await container.deleteBlob(list[i].name);
          deleted += 1;
        } catch (err) {
          context.log.error(`cron_backup retention delete ${list[i].name} err: ${err && err.message}`);
        }
      }
    }
  }
  return { kept, deleted, skippedRecent, nonMatching };
}

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 204 };
    return;
  }
  if (req.method !== 'POST') {
    context.res = { status: 405, body: { error: 'method_not_allowed' } };
    return;
  }
  if (!auth.verifyBackupSecret(req)) {
    context.res = { status: 401, body: { error: 'unauthorized' } };
    return;
  }

  const cs = process.env.RSVP_STORAGE_CONNECTION;
  if (!cs) {
    context.res = { status: 503, body: { error: 'config_missing' } };
    return;
  }

  let conn;
  try {
    conn = parseConn(cs);
  } catch (err) {
    context.log.error(`cron_backup config err: ${err && err.message}`);
    context.res = { status: 503, body: { error: 'config_invalid' } };
    return;
  }

  const tableCred = new AzureNamedKeyCredential(conn.name, conn.key);
  const blobCred = new StorageSharedKeyCredential(conn.name, conn.key);
  const blobSvc = new BlobServiceClient(conn.blobEndpoint, blobCred);
  const container = blobSvc.getContainerClient(BACKUP_CONTAINER);

  const startedAt = new Date();
  let snapshot;
  try {
    const invitesClient = new TableClient(conn.tableEndpoint, 'rsvpInvites', tableCred);
    const smslogClient = new TableClient(conn.tableEndpoint, 'rsvpSmsLog', tableCred);
    const settingsClient = new TableClient(conn.tableEndpoint, 'rsvpSettings', tableCred);
    const eventsClient = new TableClient(conn.tableEndpoint, 'rsvpEvents', tableCred);

    const [invites, smslog, settings, events] = await Promise.all([
      dumpTable(invitesClient, 'rsvpInvites'),
      dumpTable(smslogClient, 'rsvpSmsLog'),
      dumpTable(settingsClient, 'rsvpSettings'),
      dumpTable(eventsClient, 'rsvpEvents')
    ]);

    snapshot = {
      schemaVersion: SCHEMA_VERSION,
      takenAt: startedAt.toISOString(),
      account: conn.name,
      counts: {
        invites: invites.length,
        smslog: smslog.length,
        settings: settings.length,
        events: events.length
      },
      invites,
      smslog,
      settings,
      events
    };
  } catch (err) {
    context.log.error(`cron_backup dump err: ${err && err.message}`);
    storage.appendEvent({
      type: 'backup.failed',
      actor: 'cron',
      summary: `Backup dump failed: ${err && err.message}`,
      meta: { phase: 'dump' }
    }).catch(() => {});
    context.res = { status: 503, body: { error: 'dump_failed', message: err && err.message } };
    return;
  }

  const blobName = buildBlobName(startedAt);
  const payload = Buffer.from(JSON.stringify(snapshot), 'utf8');

  try {
    // createIfNotExists defaults to private (no public access); pass no opts.
    await container.createIfNotExists();
    const blobClient = container.getBlockBlobClient(blobName);
    await blobClient.uploadData(payload, {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' }
    });
  } catch (err) {
    context.log.error(`cron_backup upload err: ${err && err.message}`);
    storage.appendEvent({
      type: 'backup.failed',
      actor: 'cron',
      summary: `Backup upload failed: ${err && err.message}`,
      meta: { phase: 'upload', blobName }
    }).catch(() => {});
    context.res = { status: 503, body: { error: 'upload_failed', message: err && err.message } };
    return;
  }

  // Retention is best-effort — if it fails we still succeeded at the
  // backup itself, which is what matters.
  let retention = { kept: 0, deleted: 0, skippedRecent: 0, nonMatching: 0, error: null };
  try {
    retention = await applyRetention(container, startedAt, context);
  } catch (err) {
    context.log.error(`cron_backup retention err: ${err && err.message}`);
    retention.error = (err && err.message) || String(err);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt - startedAt;
  const sizeBytes = payload.length;
  const summary =
    `Backed up ${snapshot.counts.invites} invites, ${snapshot.counts.events} events, ` +
    `${snapshot.counts.smslog} sms log rows (${(sizeBytes / 1024).toFixed(1)} KB) in ${durationMs}ms. ` +
    `Retention: kept ${retention.kept}, deleted ${retention.deleted}.`;

  try {
    await storage.appendEvent({
      type: 'backup.completed',
      actor: 'cron',
      summary,
      meta: {
        blobName,
        sizeBytes,
        durationMs,
        counts: snapshot.counts,
        retention
      }
    });
  } catch (err) {
    context.log.error(`cron_backup event-write err: ${err && err.message}`);
  }

  context.log(`cron_backup ok blob=${blobName} size=${sizeBytes} ms=${durationMs}`);
  context.res = {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: {
      ok: true,
      blobName,
      sizeBytes,
      durationMs,
      counts: snapshot.counts,
      retention
    }
  };
};
