'use strict';

const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');

// Table names. Five logical tables:
//   Parties        PK=partyId, RK='profile'  -> party-level fields (group, locale, phone, plusOneAllowed, kidsAllowed, optedOutOfSms, smsHardFailedAt, createdAt)
//   Members        PK=partyId, RK=memberId   -> per-person rows in a party (name, role: primary/plusone/child, kid: bool, locale)
//   Responses      PK=partyId, RK=memberId   -> per-person RSVP (attending, mealChoice, dietary, songRequest, notes, submittedAt, updatedAt)
//   SmsLog         PK=partyId, RK=<revTimestamp>_<random> -> one row per SMS attempt (type, body, deliveryStatus, sentAt, segmentCount, errorCode)
//   Settings       PK='global', RK='settings' -> system settings (remindersEnabled, remindersEnabledAt)
const TABLE_PARTIES = 'rsvpParties';
const TABLE_MEMBERS = 'rsvpMembers';
const TABLE_RESPONSES = 'rsvpResponses';
const TABLE_SMSLOG = 'rsvpSmsLog';
const TABLE_SETTINGS = 'rsvpSettings';

const ALL_TABLES = [TABLE_PARTIES, TABLE_MEMBERS, TABLE_RESPONSES, TABLE_SMSLOG, TABLE_SETTINGS];

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
    parties: make(TABLE_PARTIES),
    members: make(TABLE_MEMBERS),
    responses: make(TABLE_RESPONSES),
    smslog: make(TABLE_SMSLOG),
    settings: make(TABLE_SETTINGS),
    _accountName: name,
    _endpoint: endpoint
  };
  return _clients;
}

async function ensureTables() {
  const c = getClients();
  // createTable throws 409 ResourceAlreadyExists on re-runs — that's fine,
  // it just means the schema is already set up. Swallow that one specific
  // error per table so this function is safely idempotent.
  await Promise.all(
    [c.parties, c.members, c.responses, c.smslog, c.settings].map(async (tc) => {
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
  // Drop anything after an extension marker. Examples we want to handle:
  //   "(555) 123-4567 ext 89"  -> "(555) 123-4567"
  //   "555-123-4567 x12"       -> "555-123-4567"
  //   "555.123.4567,123"       -> "555.123.4567"  (PBX comma pause)
  const cleaned = p.split(/(?:ext\.?|extension|x(?=\s|\d)|,|;)/i)[0];
  const digits = cleaned.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // Reject anything else (international, too short, too long) — caller can
  // decide what to do. We don't want bogus "+5551234567ext89" landing in
  // the table.
  return '';
}

// --- Parties --------------------------------------------------------------
async function getParty(partyId) {
  const c = getClients();
  try {
    const e = await c.parties.getEntity(partyId, 'profile');
    return entityToParty(e);
  } catch (err) {
    if (err && err.statusCode === 404) return null;
    throw err;
  }
}

async function upsertParty(party) {
  const c = getClients();
  const entity = {
    partitionKey: party.partyId,
    rowKey: 'profile',
    displayName: party.displayName || '',
    locale: party.locale || 'en',
    phone: party.phone || '',
    phoneNorm: normalizePhone(party.phone || ''),
    plusOneAllowed: !!party.plusOneAllowed,
    kidsAllowed: !!party.kidsAllowed,
    optedOutOfSms: !!party.optedOutOfSms,
    smsHardFailedAt: party.smsHardFailedAt || '',
    lastReminderSentAt: party.lastReminderSentAt || '',
    reminderCount: Number(party.reminderCount || 0),
    group: party.group || '',
    notes: party.notes || '',
    createdAt: party.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await c.parties.upsertEntity(entity, 'Replace');
}

async function patchParty(partyId, patch) {
  const c = getClients();
  const entity = { partitionKey: partyId, rowKey: 'profile', ...patch, updatedAt: new Date().toISOString() };
  await c.parties.updateEntity(entity, 'Merge');
}

async function listParties() {
  const c = getClients();
  const out = [];
  for await (const e of c.parties.listEntities()) {
    if (e.rowKey === 'profile') out.push(entityToParty(e));
  }
  return out;
}

function entityToParty(e) {
  return {
    partyId: e.partitionKey,
    displayName: e.displayName || '',
    locale: e.locale || 'en',
    phone: e.phone || '',
    phoneNorm: e.phoneNorm || '',
    plusOneAllowed: !!e.plusOneAllowed,
    kidsAllowed: !!e.kidsAllowed,
    optedOutOfSms: !!e.optedOutOfSms,
    smsHardFailedAt: e.smsHardFailedAt || '',
    lastReminderSentAt: e.lastReminderSentAt || '',
    reminderCount: Number(e.reminderCount || 0),
    group: e.group || '',
    notes: e.notes || '',
    createdAt: e.createdAt || '',
    updatedAt: e.updatedAt || ''
  };
}

// --- Members --------------------------------------------------------------
async function listMembers(partyId) {
  const c = getClients();
  const out = [];
  for await (const e of c.members.listEntities({ queryOptions: { filter: `PartitionKey eq '${partyId.replace(/'/g, "''")}'` } })) {
    out.push(entityToMember(e));
  }
  return out;
}

async function upsertMember(partyId, member) {
  const c = getClients();
  const entity = {
    partitionKey: partyId,
    rowKey: member.memberId,
    firstName: member.firstName || '',
    lastName: member.lastName || '',
    firstNameNorm: normalizeName(member.firstName || ''),
    lastNameNorm: normalizeName(member.lastName || ''),
    role: member.role || 'guest', // primary | plusone | child | guest
    isKid: !!member.isKid,
    locale: member.locale || ''
  };
  await c.members.upsertEntity(entity, 'Replace');
}

function entityToMember(e) {
  return {
    partyId: e.partitionKey,
    memberId: e.rowKey,
    firstName: e.firstName || '',
    lastName: e.lastName || '',
    firstNameNorm: e.firstNameNorm || '',
    lastNameNorm: e.lastNameNorm || '',
    role: e.role || 'guest',
    isKid: !!e.isKid,
    locale: e.locale || ''
  };
}

// Exact-match lookup across all parties. For ~150 guests, a full scan is fine.
// Returns:
//   null                                    when no member matches
//   { ambiguous: true, matchCount: N }      when 2+ DISTINCT parties match
//   { partyId, memberId, ambiguous: false } when exactly one party matches
//                                          (even if multiple members in the
//                                          same party share that name)
async function findPartyByMemberName(firstName, lastName) {
  const fn = normalizeName(firstName);
  const ln = normalizeName(lastName);
  if (fn.length < 2 || ln.length < 2) return null;
  const c = getClients();
  const matches = [];
  for await (const e of c.members.listEntities()) {
    if (e.firstNameNorm === fn && e.lastNameNorm === ln) {
      matches.push({ partyId: e.partitionKey, memberId: e.rowKey });
    }
  }
  if (matches.length === 0) return null;
  const distinctParties = new Set(matches.map((m) => m.partyId));
  if (distinctParties.size > 1) {
    return { ambiguous: true, matchCount: distinctParties.size };
  }
  return { partyId: matches[0].partyId, memberId: matches[0].memberId, ambiguous: false };
}

// Returns all parties whose normalized phone matches. Used by the SMS webhook
// so STOP/START applies to every household sharing that number.
async function findPartiesByPhoneNorm(phoneNorm) {
  if (!phoneNorm) return [];
  const all = await listParties();
  return all.filter((p) => p.phoneNorm === phoneNorm);
}

// --- Responses ------------------------------------------------------------
async function getResponses(partyId) {
  const c = getClients();
  const out = [];
  for await (const e of c.responses.listEntities({ queryOptions: { filter: `PartitionKey eq '${partyId.replace(/'/g, "''")}'` } })) {
    out.push(entityToResponse(e));
  }
  return out;
}

async function upsertResponse(partyId, memberId, fields) {
  const c = getClients();
  const now = new Date().toISOString();
  const existing = await c.responses.getEntity(partyId, memberId).catch((err) => {
    if (err && err.statusCode === 404) return null;
    throw err;
  });
  const entity = {
    partitionKey: partyId,
    rowKey: memberId,
    attending: fields.attending === null ? null : !!fields.attending,
    mealChoice: fields.mealChoice || '',
    dietary: fields.dietary || '',
    songRequest: fields.songRequest || '',
    notes: fields.notes || '',
    plusOneName: fields.plusOneName || '',
    submittedAt: existing ? (existing.submittedAt || now) : now,
    updatedAt: now,
    submittedByMethod: fields.submittedByMethod || 'web',
    sourceIpHash: fields.sourceIpHash || ''
  };
  await c.responses.upsertEntity(entity, 'Replace');
}

function entityToResponse(e) {
  return {
    partyId: e.partitionKey,
    memberId: e.rowKey,
    attending: e.attending === null || e.attending === undefined ? null : !!e.attending,
    mealChoice: e.mealChoice || '',
    dietary: e.dietary || '',
    songRequest: e.songRequest || '',
    notes: e.notes || '',
    plusOneName: e.plusOneName || '',
    submittedAt: e.submittedAt || '',
    updatedAt: e.updatedAt || '',
    submittedByMethod: e.submittedByMethod || ''
  };
}

// --- SMS Log --------------------------------------------------------------
async function appendSmsLog(partyId, entry) {
  const c = getClients();
  // Reverse-timestamp row key so most recent sorts first lexically.
  const revTs = (10_000_000_000_000 - Date.now()).toString().padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  const rowKey = `${revTs}_${rand}`;
  const entity = {
    partitionKey: partyId,
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

async function listSmsLog(partyId, limit = 50) {
  const c = getClients();
  const out = [];
  for await (const e of c.smslog.listEntities({ queryOptions: { filter: `PartitionKey eq '${partyId.replace(/'/g, "''")}'` } })) {
    out.push(entityToSmsLog(e));
    if (out.length >= limit) break;
  }
  return out;
}

function entityToSmsLog(e) {
  return {
    partyId: e.partitionKey,
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

// Status precedence so out-of-order delivery reports can't regress a final
// state. Once a message reaches a terminal state we don't accept a contradictory
// later report. (We DO still record the raw inbound event in the log even if
// we don't mutate this row — see sms_webhook.)
const TERMINAL_STATUSES = new Set(['delivered', 'failed', 'rejected', 'expired', 'unknown_terminal']);
const SUCCESS_TERMINAL = new Set(['delivered']);

async function updateSmsLogStatus(partyId, rowKey, status, errorCode) {
  const c = getClients();
  const nextStatus = (status || 'unknown').toLowerCase();
  // Read current state to enforce precedence.
  let current;
  try {
    current = await c.smslog.getEntity(partyId, rowKey);
  } catch (err) {
    if (err && err.statusCode === 404) return; // log row vanished, give up
    throw err;
  }
  const curStatus = (current.deliveryStatus || '').toLowerCase();
  // Never downgrade a delivered terminal success to a failure.
  if (SUCCESS_TERMINAL.has(curStatus) && !SUCCESS_TERMINAL.has(nextStatus)) return;
  // Don't oscillate between terminal states.
  if (TERMINAL_STATUSES.has(curStatus) && curStatus === nextStatus) return;
  await c.smslog.updateEntity({
    partitionKey: partyId,
    rowKey,
    deliveryStatus: nextStatus,
    errorCode: errorCode || current.errorCode || ''
  }, 'Merge');
}

// --- Settings -------------------------------------------------------------
const DEFAULT_SETTINGS = Object.freeze({
  remindersEnabled: false,
  remindersEnabledAt: '',
  remindersDisabledAt: '',
  remindersStopOnUtc: '2027-01-15T23:59:59-05:00' // hard stop date
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

module.exports = {
  ALL_TABLES,
  ensureTables,
  getClients,
  normalizeName,
  normalizePhone,
  // Parties
  getParty,
  upsertParty,
  patchParty,
  listParties,
  // Members
  listMembers,
  upsertMember,
  findPartyByMemberName,
  findPartiesByPhoneNorm,
  // Responses
  getResponses,
  upsertResponse,
  // SmsLog
  appendSmsLog,
  listSmsLog,
  updateSmsLogStatus,
  // Settings
  getSettings,
  setSettings,
  DEFAULT_SETTINGS
};
