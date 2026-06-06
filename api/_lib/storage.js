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
//   rsvpEvents    PK='events'                RK=<revTimestamp>_<random>
//                 Columns: type, actor, summary, meta, createdAt
//   adminMagicNonces  PK=<email-lowercased>   RK=<nonceHash>
//                 Columns: expiresAt (ISO 8601 string)
//                 Used to enforce single-use admin magic-link tokens. A row
//                 only exists once a nonce has been CLAIMED; existence ==
//                 already-used. Conditional insert (createEntity returning
//                 409 EntityAlreadyExists) makes the claim atomic across
//                 concurrent verify calls.
//
// Older v1 tables (rsvpParties, rsvpMembers, rsvpResponses) are obsolete and
// dropped by scripts/drop-old-rsvp-tables.cjs.

const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');
const fc = require('./fieldcrypto');

const TABLE_INVITES = 'rsvpInvites';
const TABLE_SMSLOG = 'rsvpSmsLog';
const TABLE_SETTINGS = 'rsvpSettings';
const TABLE_EVENTS = 'rsvpEvents';
const TABLE_ADMIN_NONCES = 'adminMagicNonces';
const TABLE_VERIFY_CODES = 'rsvpVerifyCodes';

// Tables to drop on migration cutover.
const OBSOLETE_TABLES = ['rsvpParties', 'rsvpMembers', 'rsvpResponses'];

const INVITES_PARTITION = 'invites'; // single fixed partition
const EVENTS_PARTITION = 'events';   // single fixed partition; small (~5k rows lifetime)
const VERIFY_CODES_PARTITION = 'verifyCodes'; // single fixed partition; at most ~1 row per active login
const ALL_TABLES = [TABLE_INVITES, TABLE_SMSLOG, TABLE_SETTINGS, TABLE_EVENTS, TABLE_ADMIN_NONCES, TABLE_VERIFY_CODES];

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
    events: make(TABLE_EVENTS),
    adminNonces: make(TABLE_ADMIN_NONCES),
    verifyCodes: make(TABLE_VERIFY_CODES),
    _accountName: name,
    _endpoint: endpoint,
    _key: key,
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
    [c.invites, c.smslog, c.settings, c.events, c.adminNonces, c.verifyCodes].map(async (tc) => {
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

// Returns an irreversible last-4 mask suitable for the rsvpSmsLog audit
// table. The full phone is on the matching rsvpInvites row (encrypted),
// so the log never needs to carry it -- the mask is enough for "did this
// invite get the right message?" debugging in /admin without leaking
// dialable digits if the log itself is ever exfiltrated separately.
// Idempotent: already-masked values pass through so the migration sweep
// can be re-run safely.
function maskPhone(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.startsWith('***')) return value;
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 4) return '*****';
  return '***' + digits.slice(-4);
}

// --- Invites --------------------------------------------------------------

// Reads a stored entity into the API-shaped invite object.
//
// Encrypted fields (`primaryFirstName`, `primaryLastName`, `phone`) are
// decrypted here; legacy plaintext rows (pre-migration) pass through
// untouched via decryptField's `isEncrypted` guard. The JS-level `*Norm`
// fields (phoneNorm, primaryFirstNorm, primaryLastNorm) are computed from
// the decrypted plaintext so every caller that reads them keeps working
// even after we move the at-rest normalized lookup columns to HMAC indexes.
function entityToInvite(e) {
  let payload = null;
  if (typeof e.payload === 'string' && e.payload.length > 0) {
    try { payload = JSON.parse(e.payload); } catch { payload = null; }
  }
  const firstName = fc.decryptField(e.primaryFirstName || '');
  const lastName = fc.decryptField(e.primaryLastName || '');
  const phone = fc.decryptField(e.phone || '');
  return {
    inviteId: e.rowKey,
    primaryFirstName: firstName,
    primaryLastName: lastName,
    primaryFirstNorm: normalizeName(firstName),
    primaryLastNorm: normalizeName(lastName),
    phone,
    phoneNorm: normalizePhone(phone),
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

// Encrypts PII and computes blind indexes for server-side lookup.
//
// Always re-encrypts every PII field on write under the CURRENT key (not
// PREVIOUS). That's deliberate so manual key-rotation testing is meaningful:
// editing any invite proves the new ciphertext header carries the new keyId.
//
// `primaryFirstNorm`, `primaryLastNorm`, `phoneNorm` are cleared at the DB
// level once a row is encrypted; the blind-index columns
// (`primaryFirstIndex`, `primaryLastIndex`, `phoneIndex`) take over for
// lookup queries. The JS-level `*Norm` fields remain on the in-memory invite
// object (populated by entityToInvite from decrypted plaintext) for
// backward compatibility with reminders.js / sms_webhook / etc.
function inviteToEntity(inv) {
  const rawFirst = inv.primaryFirstName || '';
  const rawLast = inv.primaryLastName || '';
  const rawPhone = inv.phone || '';
  return {
    partitionKey: INVITES_PARTITION,
    rowKey: inv.inviteId,
    // Ciphertext at rest.
    primaryFirstName: rawFirst ? fc.encryptField(rawFirst) : '',
    primaryLastName: rawLast ? fc.encryptField(rawLast) : '',
    phone: rawPhone ? fc.encryptField(rawPhone) : '',
    // Blind indexes (deterministic HMAC) for server-side filtering.
    primaryFirstIndex: fc.blindIndex(normalizeName(rawFirst), 'firstName'),
    primaryLastIndex: fc.blindIndex(normalizeName(rawLast), 'lastName'),
    phoneIndex: fc.blindIndex(normalizePhone(rawPhone), 'phone'),
    // Legacy norm columns -- explicitly blanked. Rows still carrying these
    // are pre-migration; the dual-read lookup path in findInvitesBy* handles
    // them transparently until the migration script encrypts them.
    primaryFirstNorm: '',
    primaryLastNorm: '',
    phoneNorm: '',
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

// Partial update — pass only the fields you want to change. When one of the
// PII fields is in the patch we update its ciphertext AND its blind index
// AND its legacy plaintext-norm column atomically in the same Merge call,
// so the row can't end up in an inconsistent state (e.g., new ciphertext
// but old index).
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
      const raw = v || '';
      entity.phone = raw ? fc.encryptField(raw) : '';
      entity.phoneIndex = fc.blindIndex(normalizePhone(raw), 'phone');
      entity.phoneNorm = ''; // clear legacy plaintext-norm
    } else if (k === 'primaryFirstName') {
      const raw = v || '';
      entity.primaryFirstName = raw ? fc.encryptField(raw) : '';
      entity.primaryFirstIndex = fc.blindIndex(normalizeName(raw), 'firstName');
      entity.primaryFirstNorm = '';
    } else if (k === 'primaryLastName') {
      const raw = v || '';
      entity.primaryLastName = raw ? fc.encryptField(raw) : '';
      entity.primaryLastIndex = fc.blindIndex(normalizeName(raw), 'lastName');
      entity.primaryLastNorm = '';
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
//
// Dual-read fallback: filters match EITHER the new HMAC blind index columns
// OR the legacy plaintext-norm columns. Encrypted rows have the indexes and
// empty norm columns; legacy rows have plaintext norms and empty indexes.
// Both paths coexist during the migration window; once the migration script
// has re-written every row, the legacy clause stops matching anything and
// can be removed in a follow-up cleanup.
async function findInviteByPrimaryName(firstName, lastName) {
  const fn = normalizeName(firstName);
  const ln = normalizeName(lastName);
  if (fn.length < 2 || ln.length < 2) return null;
  const c = getClients();
  const esc = (s) => s.replace(/'/g, "''");
  const fnIdx = fc.blindIndex(fn, 'firstName');
  const lnIdx = fc.blindIndex(ln, 'lastName');
  const filter = `PartitionKey eq '${INVITES_PARTITION}' and (`
    + `(primaryFirstIndex eq '${esc(fnIdx)}' and primaryLastIndex eq '${esc(lnIdx)}')`
    + ` or `
    + `(primaryFirstNorm eq '${esc(fn)}' and primaryLastNorm eq '${esc(ln)}')`
    + `)`;
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

// Returns all invites whose primary last name matches. Used by the public
// RSVP lookup flow (last-name-only primary, with phone-last-4 disambiguation
// for the small set of families that share a surname). Single-partition scan
// with server-side filter; ~80 invites total so cheap. Dual-read fallback
// as in findInviteByPrimaryName.
async function findInvitesByLastName(lastName) {
  const ln = normalizeName(lastName);
  if (ln.length < 2) return [];
  const c = getClients();
  const esc = (s) => s.replace(/'/g, "''");
  const lnIdx = fc.blindIndex(ln, 'lastName');
  const filter = `PartitionKey eq '${INVITES_PARTITION}' and (`
    + `primaryLastIndex eq '${esc(lnIdx)}'`
    + ` or `
    + `primaryLastNorm eq '${esc(ln)}'`
    + `)`;
  const out = [];
  for await (const e of c.invites.listEntities({ queryOptions: { filter } })) {
    out.push(entityToInvite(e));
  }
  return out;
}

// Returns all invites that share this normalized phone. Used by the SMS
// webhook so STOP/START applies to every household sharing a number, and by
// the public RSVP "look me up by phone" fallback path. Dual-read fallback
// covers the migration window: filter matches either the HMAC blind index
// on encrypted rows or the legacy plaintext-norm column on un-migrated rows.
async function findInvitesByPhoneNorm(phoneNorm) {
  if (!phoneNorm) return [];
  const c = getClients();
  const esc = (s) => s.replace(/'/g, "''");
  const idx = fc.blindIndex(phoneNorm, 'phone');
  const filter = `PartitionKey eq '${INVITES_PARTITION}' and (`
    + `phoneIndex eq '${esc(idx)}'`
    + ` or `
    + `phoneNorm eq '${esc(phoneNorm)}'`
    + `)`;
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
    // RSVP submissions are stored canonically in English. The invite locale is
    // only needed before a response to choose SMS reminder copy.
    locale: 'en',
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
    // Always store only the last-4 mask in the audit log; the full number
    // lives encrypted on the rsvpInvites row this entry is partitioned by.
    toPhone: maskPhone(entry.toPhone || ''),
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

// --- Events (audit log) ---------------------------------------------------
//
// Append-only activity log surfaced in the admin "Recent activity" panel and
// included in nightly backup snapshots. Single fixed partition; row key is a
// padded reverse-timestamp so listEntities returns newest-first lexically.
//
// Types are namespaced by source:
//   rsvp.*    public RSVP submissions
//   admin.*   admin-page actions
//   cron.*    scheduled jobs (reminders, backup)
//   deploy.*  GitHub Actions deploy outcomes (via /api/internal/event)
//   backup.*  GitHub Actions backup outcomes (also via cron_backup itself)
//   sms.*     SMS webhook state transitions (failures only — success is noise)
//
// Field caps keep one row well under Table Storage's 64KB per-property and
// 1MB per-entity limits, and bound admin-panel render cost.

const EVENT_TYPE_MAX = 64;
const EVENT_ACTOR_MAX = 128;
const EVENT_SUMMARY_MAX = 500;
const EVENT_META_MAX = 4096;

function buildEventRowKey() {
  // padStart(13,'0') keeps newest-first order stable across the next ~317
  // years (Number.MAX_SAFE_INTEGER ~= 9e15). Random suffix gives ~36^6
  // (~2 billion) collision resistance per millisecond — plenty for our
  // single-digit-per-second peak rate.
  const revTs = (10_000_000_000_000 - Date.now()).toString().padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${revTs}_${rand}`;
}

function clampStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

function entityToEvent(e) {
  let meta = null;
  if (typeof e.meta === 'string' && e.meta.length > 0) {
    try { meta = JSON.parse(e.meta); } catch { meta = null; }
  }
  return {
    rowKey: e.rowKey,
    type: e.type || '',
    actor: e.actor || '',
    summary: e.summary || '',
    meta,
    createdAt: e.createdAt || ''
  };
}

// Writes one event. Caller must `await`; we never silently fire-and-forget
// because Azure Functions can freeze the Node event loop on early return.
// Idempotently creates the table on the first cold-start where it doesn't
// exist yet (handles 404 then retries once).
async function appendEvent({ type, actor, summary, meta }) {
  if (!type || typeof type !== 'string') {
    throw new Error('appendEvent requires a string `type`');
  }
  const c = getClients();
  const metaStr = (() => {
    if (meta == null) return '';
    try {
      const s = typeof meta === 'string' ? meta : JSON.stringify(meta);
      return clampStr(s, EVENT_META_MAX);
    } catch {
      return '';
    }
  })();
  const entity = {
    partitionKey: EVENTS_PARTITION,
    rowKey: buildEventRowKey(),
    type: clampStr(type, EVENT_TYPE_MAX),
    actor: clampStr(actor || '', EVENT_ACTOR_MAX),
    summary: clampStr(summary || '', EVENT_SUMMARY_MAX),
    meta: metaStr,
    createdAt: new Date().toISOString()
  };
  try {
    await c.events.createEntity(entity);
  } catch (err) {
    // Table missing → lazy-create once (handles brand-new deploys where
    // ensureTables hasn't been run yet) then retry the original insert.
    const code = err && (err.code || err.errorCode || '');
    const status = err && err.statusCode;
    const isTableMissing = status === 404 || code === 'TableNotFound';
    if (!isTableMissing) throw err;
    try { await c.events.createTable(); }
    catch (e2) {
      if (!(e2 && (e2.statusCode === 409 || e2.code === 'TableAlreadyExists'))) throw e2;
    }
    await c.events.createEntity(entity);
  }
  return entity.rowKey;
}

async function listEvents(limit = 200) {
  const c = getClients();
  const out = [];
  const filter = `PartitionKey eq '${EVENTS_PARTITION}'`;
  try {
    for await (const e of c.events.listEntities({ queryOptions: { filter } })) {
      out.push(entityToEvent(e));
      if (out.length >= limit) break;
    }
  } catch (err) {
    // Empty table on first deploy — return [] rather than 503'ing the admin
    // page. Caller still sees the panel; it just says "no activity yet".
    const status = err && err.statusCode;
    const code = err && (err.code || err.errorCode || '');
    if (status === 404 || code === 'TableNotFound') return [];
    throw err;
  }
  return out;
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

// --- Admin magic-link nonces ---------------------------------------------
// Single-use enforcement for admin email magic links. Token verification
// calls claimAdminNonce(email, nonceHash, expiresAtIso). The atomic
// "claim" is an unconditional Table createEntity -- success means we
// inserted, 409 EntityAlreadyExists means a previous verify call already
// consumed this nonce. The row carries `expiresAt` purely so the prune
// helper can sweep old rows; correctness does NOT depend on prune ever
// running because the HMAC signature on the token still validates expiry
// independently.

async function claimAdminNonce(emailLower, nonceHash, expiresAtIso) {
  if (!emailLower || !nonceHash) {
    return { claimed: false, reason: 'bad_input' };
  }
  const c = getClients();
  const entity = {
    partitionKey: emailLower,
    rowKey: nonceHash,
    expiresAt: expiresAtIso || ''
  };
  try {
    await c.adminNonces.createEntity(entity);
    return { claimed: true };
  } catch (err) {
    const status = err && err.statusCode;
    const code = err && (err.code || err.errorCode || '');
    if (status === 409 || code === 'EntityAlreadyExists') {
      return { claimed: false, reason: 'already_used' };
    }
    // Table missing -> lazy-create, then retry once. Brand-new deploys
    // won't have hit ensureTables yet.
    const isTableMissing = status === 404 || code === 'TableNotFound';
    if (!isTableMissing) throw err;
    try { await c.adminNonces.createTable(); }
    catch (e2) {
      if (!(e2 && (e2.statusCode === 409 || e2.code === 'TableAlreadyExists'))) throw e2;
    }
    try {
      await c.adminNonces.createEntity(entity);
      return { claimed: true };
    } catch (err2) {
      const status2 = err2 && err2.statusCode;
      const code2 = err2 && (err2.code || err2.errorCode || '');
      if (status2 === 409 || code2 === 'EntityAlreadyExists') {
        return { claimed: false, reason: 'already_used' };
      }
      throw err2;
    }
  }
}

// --- RSVP guest verify codes ---------------------------------------------
// One-time-passcode storage for the RSVP step-up auth flow. After a
// successful name lookup we issue a 10-minute lookup ticket cookie; the
// guest then chooses "Text me a code" (this table) or "Text me a link"
// (no row needed, magic-link token is self-contained).
//
// Single row per inviteId — sending a new code overwrites the previous
// one (last-write-wins). Stored fields:
//   codeHash    HMAC-SHA256(secret, purpose | code) hex; never the raw code
//   expiresAtMs ASCII decimal epoch ms
//   attempts    number of failed verify attempts; lock at 5
//   sentVia     'code' | 'link' — informational only
//   sentAtMs    ASCII decimal epoch ms; powers the per-invite resend cooldown
//   createdAt   ISO 8601 string
//
// PK is the fixed VERIFY_CODES_PARTITION so single-table point-reads stay
// O(1) on the partition. RK is the inviteId so we can getEntity by it.

async function putVerifyCode(inviteId, { codeHash, expiresAtMs, sentVia, sentAtMs }) {
  if (!inviteId) throw new Error('putVerifyCode requires inviteId');
  const c = getClients();
  const entity = {
    partitionKey: VERIFY_CODES_PARTITION,
    rowKey: inviteId,
    codeHash: codeHash || '',
    expiresAtMs: String(expiresAtMs || 0),
    attempts: 0,
    sentVia: sentVia || '',
    sentAtMs: String(sentAtMs || Date.now()),
    createdAt: new Date().toISOString()
  };
  try {
    await c.verifyCodes.upsertEntity(entity, 'Replace');
  } catch (err) {
    const status = err && err.statusCode;
    const code = err && (err.code || err.errorCode || '');
    const isTableMissing = status === 404 || code === 'TableNotFound';
    if (!isTableMissing) throw err;
    try { await c.verifyCodes.createTable(); }
    catch (e2) {
      if (!(e2 && (e2.statusCode === 409 || e2.code === 'TableAlreadyExists'))) throw e2;
    }
    await c.verifyCodes.upsertEntity(entity, 'Replace');
  }
}

async function getVerifyCode(inviteId) {
  if (!inviteId) return null;
  const c = getClients();
  try {
    const e = await c.verifyCodes.getEntity(VERIFY_CODES_PARTITION, inviteId);
    return {
      inviteId,
      codeHash: String(e.codeHash || ''),
      expiresAtMs: Number(e.expiresAtMs || 0),
      attempts: Number(e.attempts || 0),
      sentVia: String(e.sentVia || ''),
      sentAtMs: Number(e.sentAtMs || 0),
      createdAt: String(e.createdAt || '')
    };
  } catch (err) {
    if (err && err.statusCode === 404) return null;
    throw err;
  }
}

async function incrementVerifyAttempts(inviteId) {
  if (!inviteId) throw new Error('incrementVerifyAttempts requires inviteId');
  const c = getClients();
  // Read-modify-write. Concurrent verify calls for the same inviteId are
  // extraordinarily rare (single guest, single device) so we don't bother
  // with ETag CAS — the worst case is one missed increment, which the
  // 5-attempt cap absorbs.
  let current;
  try {
    current = await c.verifyCodes.getEntity(VERIFY_CODES_PARTITION, inviteId);
  } catch (err) {
    if (err && err.statusCode === 404) return 0;
    throw err;
  }
  const next = Number(current.attempts || 0) + 1;
  await c.verifyCodes.updateEntity({
    partitionKey: VERIFY_CODES_PARTITION,
    rowKey: inviteId,
    attempts: next
  }, 'Merge');
  return next;
}

async function deleteVerifyCode(inviteId) {
  if (!inviteId) return;
  const c = getClients();
  try {
    await c.verifyCodes.deleteEntity(VERIFY_CODES_PARTITION, inviteId);
  } catch (err) {
    if (err && err.statusCode === 404) return;
    throw err;
  }
}


// Best-effort sweep of expired admin nonces. Safe to call from a cron or
// from a periodic admin action. Bounded by `maxRows` to keep one invocation
// cheap; remaining rows roll over to the next sweep.
async function pruneExpiredAdminNonces(maxRows = 500) {
  const c = getClients();
  const nowIso = new Date().toISOString();
  let deleted = 0;
  let scanned = 0;
  try {
    for await (const e of c.adminNonces.listEntities()) {
      scanned += 1;
      if (scanned >= maxRows + 1) break;
      const exp = String(e.expiresAt || '');
      if (!exp || exp < nowIso) {
        try {
          await c.adminNonces.deleteEntity(e.partitionKey, e.rowKey);
          deleted += 1;
        } catch (err) {
          // Race / already-deleted -- ignore.
          const status = err && err.statusCode;
          if (status === 404) continue;
          throw err;
        }
      }
    }
  } catch (err) {
    const status = err && err.statusCode;
    const code = err && (err.code || err.errorCode || '');
    if (status === 404 || code === 'TableNotFound') return { scanned: 0, deleted: 0 };
    throw err;
  }
  return { scanned, deleted };
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
  EVENTS_PARTITION,
  OBSOLETE_TABLES,
  // setup
  ensureTables,
  getClients,
  // helpers
  normalizeName,
  normalizePhone,
  maskPhone,
  // invites
  getInvite,
  upsertInvite,
  patchInvite,
  deleteInvite,
  listInvites,
  findInviteByPrimaryName,
  findInvitesByLastName,
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
  // events
  appendEvent,
  listEvents,
  // admin magic-link nonces (single-use enforcement)
  claimAdminNonce,
  pruneExpiredAdminNonces,
  // RSVP guest verify codes (step-up auth)
  putVerifyCode,
  getVerifyCode,
  incrementVerifyAttempts,
  deleteVerifyCode,
  // migration
  dropObsoleteTables,
  // Test hooks -- exposed so unit tests can exercise the encryption + blind
  // index wiring without standing up real Azure Table Storage. Production
  // code paths should NOT import these directly.
  _testHooks: { entityToInvite, inviteToEntity }
};
