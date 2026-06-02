'use strict';

// RSVP storage layer (v2 — single-table model).
//
// Three logical tables:
//   rsvpInvites   PK='invites'              RK=inviteId
//                 Columns: primaryFirstName, primaryLastName, primaryFirstNorm,
//                          primaryLastNorm, phone, phoneNorm, locale,
//                          optedOutOfSms, smsHardFailedAt, lastReminderSentAt,
//                          reminderCount, responded, respondedAt, respondedLate,
//                          payload (JSON string), adminNotes, createdAt, updatedAt
//   rsvpSettings  PK='global'               RK='settings'
//                 Columns: remindersEnabled, remindersEnabledAt, remindersDisabledAt
//   rsvpSmsLog    PK=inviteId               RK=<revTimestamp>_<random>
//                 Columns: type, body, bodyLen, toPhone, deliveryStatus,
//                          errorCode, sentAt, correlationId
//
// Older v1 tables (rsvpParties, rsvpMembers, rsvpResponses) are obsolete and
// dropped by scripts/drop-old-rsvp-tables.cjs.

const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');

const TABLE_INVITES = 'rsvpInvites';
const TABLE_SMSLOG = 'rsvpSmsLog';
const TABLE_SETTINGS = 'rsvpSettings';

// Tables to drop on migration cutover.
const OBSOLETE_TABLES = ['rsvpParties', 'rsvpMembers', 'rsvpResponses'];

const INVITES_PARTITION = 'invites'; // single fixed partition
const ALL_TABLES = [TABLE_INVITES, TABLE_SMSLOG, TABLE_SETTINGS];

let _clients = null;

function parseConnectionString(cs) {
  const parts = {};
  for (const seg of cs.split(';')) {
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;
    parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  const name = parts.AccountName;
  const key = parts.AccountKey;
  if (!name || !key) {
    throw new Error('CONFIG_BAD_RSVP_STORAGE_CONNECTION');
  }
  const endpoint = parts.TableEndpoint
    || `https://${name}.table.${parts.EndpointSuffix || 'core.windows.net'}`;
  return { name, key, endpoint };
}

function getClients() {
  if (_clients) return _clients;
  const cs = process.env.RSVP_STORAGE_CONNECTION;
  if (!cs) {
    throw new Error('CONFIG_MISSING_RSVP_STORAGE_CONNECTION');
  }
  const { name, key, endpoint } = parseConnectionString(cs);
  const cred = new AzureNamedKeyCredential(name, key);
  const make = (table) => new TableClient(endpoint, table, cred, { allowInsecureConnection: false });
  _clients = {
    invites: make(TABLE_INVITES),
    smslog: make(TABLE_SMSLOG),
    settings: make(TABLE_SETTINGS),
    _accountName: name,
    _endpoint: endpoint,
    _make: make
  };
  return _clients;
}

async function ensureTables() {
  const c = getClients();
  // createTable returns 409 ResourceAlreadyExists on re-runs — that's fine,
  // it means the schema is already set up. Swallow that one specific error
  // per table so this function is safely idempotent.
  await Promise.all(
    [c.invites, c.smslog, c.settings].map(async (tc) => {
      try {
        await tc.createTable();
      } catch (err) {
        if (err && (err.statusCode === 409 || err.code === 'TableAlreadyExists')) return;
        throw err;
      }
    })
  );
}

function normalizeName(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Returns a normalized E.164-style US phone (+1XXXXXXXXXX) or '' if the input
// can't be confidently interpreted as a 10-digit US number. We strip common
// extension suffixes ("ext", "x") because including the extension digits in
// the SMS destination produces a permanent ACS failure.
function normalizePhone(p) {
  if (typeof p !== 'string') return '';
  const cleaned = p.split(/(?:ext\.?|extension|x(?=\s|\d)|,|;)/i)[0];
  const digits = cleaned.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

// --- Invites --------------------------------------------------------------

function entityToInvite(e) {
  let payload = null;
  if (typeof e.payload === 'string' && e.payload.length > 0) {
    try { payload = JSON.parse(e.payload); } catch { payload = null; }
  }
  return {
    inviteId: e.rowKey,
    primaryFirstName: e.primaryFirstName || '',
    primaryLastName: e.primaryLastName || '',
    primaryFirstNorm: e.primaryFirstNorm || '',
    primaryLastNorm: e.primaryLastNorm || '',
    phone: e.phone || '',
    phoneNorm: e.phoneNorm || '',
    locale: e.locale || 'en',
    optedOutOfSms: !!e.optedOutOfSms,
    smsHardFailedAt: e.smsHardFailedAt || '',
    lastReminderSentAt: e.lastReminderSentAt || '',
    reminderCount: Number(e.reminderCount || 0),
    responded: !!e.responded,
    respondedAt: e.respondedAt || '',
    respondedLate: !!e.respondedLate,
    payload, // parsed JSON or null
    adminNotes: e.adminNotes || '',
    createdAt: e.createdAt || '',
    updatedAt: e.updatedAt || ''
  };
}

function inviteToEntity(inv) {
  const phoneNorm = normalizePhone(inv.phone || '');
  return {
    partitionKey: INVITES_PARTITION,
    rowKey: inv.inviteId,
    primaryFirstName: inv.primaryFirstName || '',
    primaryLastName: inv.primaryLastName || '',
    primaryFirstNorm: normalizeName(inv.primaryFirstName || ''),
    primaryLastNorm: normalizeName(inv.primaryLastName || ''),
    phone: inv.phone || '',
    phoneNorm,
    locale: inv.locale === 'es' ? 'es' : 'en',
    optedOutOfSms: !!inv.optedOutOfSms,
    smsHardFailedAt: inv.smsHardFailedAt || '',
    lastReminderSentAt: inv.lastReminderSentAt || '',
    reminderCount: Number(inv.reminderCount || 0),
    responded: !!inv.responded,
    respondedAt: inv.respondedAt || '',
    respondedLate: !!inv.respondedLate,
    payload: typeof inv.payload === 'string' ? inv.payload : (inv.payload ? JSON.stringify(inv.payload) : ''),
    adminNotes: inv.adminNotes || '',
    createdAt: inv.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function getInvite(inviteId) {
  if (!inviteId) return null;
  const c = getClients();
  try {
    const e = await c.invites.getEntity(INVITES_PARTITION, inviteId);
    return entityToInvite(e);
  } catch (err) {
    if (err && err.statusCode === 404) return null;
    throw err;
  }
}

async function upsertInvite(invite) {
  const c = getClients();
  if (!invite || !invite.inviteId) throw new Error('upsertInvite requires inviteId');
  const entity = inviteToEntity(invite);
  await c.invites.upsertEntity(entity, 'Replace');
  return entityToInvite(entity);
}

// Partial update — pass only the fields you want to change. If `phone` is in
// the patch, we recompute `phoneNorm` automatically.
async function patchInvite(inviteId, patch) {
  if (!inviteId) throw new Error('patchInvite requires inviteId');
  const c = getClients();
  const entity = {
    partitionKey: INVITES_PARTITION,
    rowKey: inviteId,
    updatedAt: new Date().toISOString()
  };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'phone') {
      entity.phone = v || '';
      entity.phoneNorm = normalizePhone(v || '');
    } else if (k === 'primaryFirstName') {
      entity.primaryFirstName = v || '';
      entity.primaryFirstNorm = normalizeName(v || '');
    } else if (k === 'primaryLastName') {
      entity.primaryLastName = v || '';
      entity.primaryLastNorm = normalizeName(v || '');
    } else if (k === 'payload' && typeof v !== 'string') {
      entity.payload = v ? JSON.stringify(v) : '';
    } else {
      entity[k] = v;
    }
  }
  await c.invites.updateEntity(entity, 'Merge');
}

async function deleteInvite(inviteId) {
  if (!inviteId) throw new Error('deleteInvite requires inviteId');
  const c = getClients();
  try {
    await c.invites.deleteEntity(INVITES_PARTITION, inviteId);
  } catch (err) {
    if (err && err.statusCode === 404) return { deleted: false, smsRowsDeleted: 0 };
    throw err;
  }
  // Cascade — drop all SMS log rows for this invite. Best-effort; we don't
  // want a partial-cleanup failure to block the user from re-creating the
  // invite by the same id later.
  const smsRowsDeleted = await deleteSmsLogForInvite(inviteId).catch(() => 0);
  return { deleted: true, smsRowsDeleted };
}

async function listInvites() {
  const c = getClients();
  const out = [];
  for await (const e of c.invites.listEntities()) {
    if (e.partitionKey !== INVITES_PARTITION) continue;
    out.push(entityToInvite(e));
  }
  return out;
}

// Returns one of:
//   null                                   — no match
//   { ambiguous: true, matchCount: N }     — multiple invites share this name
//   { inviteId }                           — exactly one match
//
// At ~80 invites this is a single-partition scan with server-side filter.
async function findInviteByPrimaryName(firstName, lastName) {
  const fn = normalizeName(firstName);
  const ln = normalizeName(lastName);
  if (fn.length < 2 || ln.length < 2) return null;
  const c = getClients();
  const filter = `PartitionKey eq '${INVITES_PARTITION}' and primaryFirstNorm eq '${fn.replace(/'/g, "''")}' and primaryLastNorm eq '${ln.replace(/'/g, "''")}'`;
  const matches = [];
  for await (const e of c.invites.listEntities({ queryOptions: { filter } })) {
    matches.push(e.rowKey);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return { ambiguous: true, matchCount: matches.length };
  }
  return { inviteId: matches[0], ambiguous: false };
}

// Returns all invites that share this normalized phone. Used by the SMS
// webhook so STOP/START applies to every household sharing a number.
async function findInvitesByPhoneNorm(phoneNorm) {
  if (!phoneNorm) return [];
  const c = getClients();
  const filter = `PartitionKey eq '${INVITES_PARTITION}' and phoneNorm eq '${phoneNorm.replace(/'/g, "''")}'`;
  const out = [];
  for await (const e of c.invites.listEntities({ queryOptions: { filter } })) {
    out.push(entityToInvite(e));
  }
  return out;
}

// Marks an invite responded (with the given payload + late flag). Single
// merge update; cheap.
async function markResponded(inviteId, payloadJson, opts = {}) {
  if (!inviteId) throw new Error('markResponded requires inviteId');
  const c = getClients();
  await c.invites.updateEntity({
    partitionKey: INVITES_PARTITION,
    rowKey: inviteId,
    payload: payloadJson,
    responded: true,
    respondedAt: opts.respondedAt || new Date().toISOString(),
    respondedLate: !!opts.late,
    updatedAt: new Date().toISOString()
  }, 'Merge');
}

// --- SMS Log --------------------------------------------------------------

async function appendSmsLog(inviteId, entry) {
  const c = getClients();
  // Reverse-timestamp row key so most recent sorts first lexically.
  const revTs = (10_000_000_000_000 - Date.now()).toString().padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  const rowKey = `${revTs}_${rand}`;
  const entity = {
    partitionKey: inviteId,
    rowKey,
    type: entry.type || 'reminder',
    body: entry.body || '',
    bodyLen: (entry.body || '').length,
    toPhone: entry.toPhone || '',
    deliveryStatus: entry.deliveryStatus || 'pending',
    errorCode: entry.errorCode || '',
    sentAt: entry.sentAt || new Date().toISOString(),
    correlationId: entry.correlationId || ''
  };
  await c.smslog.createEntity(entity);
  return rowKey;
}

async function listSmsLog(inviteId, limit = 50) {
  const c = getClients();
  const out = [];
  const filter = `PartitionKey eq '${String(inviteId).replace(/'/g, "''")}'`;
  for await (const e of c.smslog.listEntities({ queryOptions: { filter } })) {
    out.push(entityToSmsLog(e));
    if (out.length >= limit) break;
  }
  return out;
}

async function deleteSmsLogForInvite(inviteId) {
  if (!inviteId) return 0;
  const c = getClients();
  const filter = `PartitionKey eq '${String(inviteId).replace(/'/g, "''")}'`;
  let n = 0;
  for await (const e of c.smslog.listEntities({ queryOptions: { filter } })) {
    try {
      await c.smslog.deleteEntity(e.partitionKey, e.rowKey);
      n += 1;
    } catch (err) {
      if (!err || err.statusCode !== 404) throw err;
    }
  }
  return n;
}

function entityToSmsLog(e) {
  return {
    inviteId: e.partitionKey,
    rowKey: e.rowKey,
    type: e.type || '',
    body: e.body || '',
    bodyLen: Number(e.bodyLen || 0),
    toPhone: e.toPhone || '',
    deliveryStatus: e.deliveryStatus || '',
    errorCode: e.errorCode || '',
    sentAt: e.sentAt || '',
    correlationId: e.correlationId || ''
  };
}

const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'rejected', 'expired', 'unknown_terminal']);
const SUCCESS_TERMINAL = new Set(['delivered']);

async function updateSmsLogStatus(inviteId, rowKey, status, errorCode) {
  const c = getClients();
  const nextStatus = (status || 'unknown').toLowerCase();
  let current;
  try {
    current = await c.smslog.getEntity(inviteId, rowKey);
  } catch (err) {
    if (err && err.statusCode === 404) return;
    throw err;
  }
  const curStatus = (current.deliveryStatus || '').toLowerCase();
  if (SUCCESS_TERMINAL.has(curStatus) && !SUCCESS_TERMINAL.has(nextStatus)) return;
  if (TERMINAL_STATUSES.has(curStatus) && curStatus === nextStatus) return;
  await c.smslog.updateEntity({
    partitionKey: inviteId,
    rowKey,
    deliveryStatus: nextStatus,
    errorCode: errorCode || current.errorCode || ''
  }, 'Merge');
}

// Scans the most recent N smslog rows across all invites for one matching
// correlationId (== ACS messageId). Returns { partitionKey, rowKey } or null.
// Scan cap sized for the full wedding window: ~80 invites × monthly reminders
// for 8 months × ~2 rows/send (outbound + delivery report) ≈ 1280; plus
// opt-in/out events. 10k gives ~8x headroom before we'd need a secondary
// lookup table.
async function findSmsLogByCorrelationId(correlationId, scanLimit = 10000) {
  if (!correlationId) return null;
  const c = getClients();
  let scanned = 0;
  for await (const e of c.smslog.listEntities()) {
    if (e.correlationId === correlationId) {
      return { partitionKey: e.partitionKey, rowKey: e.rowKey };
    }
    if (++scanned >= scanLimit) break;
  }
  return null;
}

// --- Settings -------------------------------------------------------------

const DEFAULT_SETTINGS = Object.freeze({
  remindersEnabled: false,
  remindersEnabledAt: '',
  remindersDisabledAt: '',
  remindersStopOnUtc: '2027-01-15T23:59:59-05:00'
});

async function getSettings() {
  const c = getClients();
  try {
    const e = await c.settings.getEntity('global', 'settings');
    return {
      ...DEFAULT_SETTINGS,
      remindersEnabled: !!e.remindersEnabled,
      remindersEnabledAt: e.remindersEnabledAt || '',
      remindersDisabledAt: e.remindersDisabledAt || ''
    };
  } catch (err) {
    if (err && err.statusCode === 404) return { ...DEFAULT_SETTINGS };
    throw err;
  }
}

async function setSettings(patch) {
  const c = getClients();
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await c.settings.upsertEntity({
    partitionKey: 'global',
    rowKey: 'settings',
    remindersEnabled: !!next.remindersEnabled,
    remindersEnabledAt: next.remindersEnabledAt || '',
    remindersDisabledAt: next.remindersDisabledAt || '',
    updatedAt: new Date().toISOString()
  }, 'Replace');
  return next;
}

// --- Migration helper ----------------------------------------------------

// One-shot helper to drop the obsolete v1 tables. Safe to run multiple times.
// Returns a per-table {dropped, error} map.
async function dropObsoleteTables() {
  const c = getClients();
  const out = {};
  for (const name of OBSOLETE_TABLES) {
    const tc = c._make(name);
    try {
      await tc.deleteTable();
      out[name] = { dropped: true };
    } catch (err) {
      // 404 = already gone. Other codes => surface them but don't throw.
      if (err && err.statusCode === 404) {
        out[name] = { dropped: false, reason: 'not_found' };
      } else {
        out[name] = { dropped: false, error: (err && err.message) || String(err) };
      }
    }
  }
  return out;
}

module.exports = {
  // tables / constants
  ALL_TABLES,
  INVITES_PARTITION,
  OBSOLETE_TABLES,
  // setup
  ensureTables,
  getClients,
  // helpers
  normalizeName,
  normalizePhone,
  // invites
  getInvite,
  upsertInvite,
  patchInvite,
  deleteInvite,
  listInvites,
  findInviteByPrimaryName,
  findInvitesByPhoneNorm,
  markResponded,
  // smslog
  appendSmsLog,
  listSmsLog,
  deleteSmsLogForInvite,
  updateSmsLogStatus,
  findSmsLogByCorrelationId,
  // settings
  getSettings,
  setSettings,
  DEFAULT_SETTINGS,
  // migration
  dropObsoleteTables
};
