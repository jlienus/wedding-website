'use strict';

const crypto = require('crypto');

const MAGIC_PURPOSE = 'rsvp-magic-v1';
const SESSION_PURPOSE = 'rsvp-session-v1';
const SESSION_COOKIE_NAME = 'rsvp_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 60; // 60 days, covers post-deadline extension to Jan 15
const SIG_LEN_CHARS = 22; // ~128 bits of base64url

function getMagicSecret() {
  const s = process.env.RSVP_MAGIC_SECRET;
  if (!s || s.length < 32) {
    throw new Error('CONFIG_MISSING_RSVP_MAGIC_SECRET');
  }
  return s;
}

function getSessionSecret() {
  const s = process.env.RSVP_SESSION_SECRET || process.env.RSVP_MAGIC_SECRET;
  if (!s || s.length < 32) {
    throw new Error('CONFIG_MISSING_RSVP_SESSION_SECRET');
  }
  return s;
}

function getCronSecret() {
  const s = process.env.RSVP_CRON_SECRET;
  if (!s || s.length < 32) {
    throw new Error('CONFIG_MISSING_RSVP_CRON_SECRET');
  }
  return s;
}

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmacSign(secret, purpose, payload) {
  const h = crypto.createHmac('sha256', secret);
  h.update(purpose);
  h.update('\0');
  h.update(payload);
  return b64urlEncode(h.digest()).slice(0, SIG_LEN_CHARS);
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// --- Magic-link tokens ----------------------------------------------------
// Format: <partyId>.<sig>
// Used in SMS links: /api/rsvp/magic?t=<partyId>.<sig>

function signMagicToken(partyId) {
  const sig = hmacSign(getMagicSecret(), MAGIC_PURPOSE, partyId);
  return `${partyId}.${sig}`;
}

function verifyMagicToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const partyId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(partyId)) return null;
  if (sig.length !== SIG_LEN_CHARS) return null;
  const expected = hmacSign(getMagicSecret(), MAGIC_PURPOSE, partyId);
  return constantTimeEqual(sig, expected) ? partyId : null;
}

// --- Session cookies ------------------------------------------------------
// Format: <partyId>.<issuedAtMs>.<sig>
// Issued after successful name lookup or magic-link click.
// HttpOnly + Secure + SameSite=Lax cookie sent to /api/rsvp/submit.

function signSession(partyId, issuedAtMs) {
  const payload = `${partyId}|${issuedAtMs}`;
  return hmacSign(getSessionSecret(), SESSION_PURPOSE, payload);
}

function issueSessionCookie(partyId, opts = {}) {
  const now = Date.now();
  const sig = signSession(partyId, now);
  const value = `${partyId}.${now}.${sig}`;
  const maxAge = opts.maxAgeSec || SESSION_MAX_AGE_SEC;
  const attrs = [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  return attrs.join('; ');
}

function clearSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0'
  ].join('; ');
}

function readCookie(req, name) {
  const header = (req.headers && (req.headers.cookie || req.headers.Cookie)) || '';
  if (!header) return '';
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return '';
}

function verifySessionCookie(req, maxAgeSec) {
  const raw = readCookie(req, SESSION_COOKIE_NAME);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [partyId, issuedAtStr, sig] = parts;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(partyId)) return null;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
  const ageMs = Date.now() - issuedAt;
  const limit = (maxAgeSec || SESSION_MAX_AGE_SEC) * 1000;
  if (ageMs < 0 || ageMs > limit) return null;
  const expected = signSession(partyId, issuedAt);
  return constantTimeEqual(sig, expected) ? { partyId, issuedAt } : null;
}

// --- Admin auth (SWA principal) -------------------------------------------
// SWA forwards an x-ms-client-principal header (base64 JSON) when the user
// has authenticated via a configured provider. We require GitHub login as
// user `jlienus` (the repo owner). Defense in depth alongside route config.

const ADMIN_GITHUB_USERNAME = (process.env.ADMIN_GITHUB_USERNAME || 'jlienus').toLowerCase();

function readAdminPrincipal(req) {
  const header = (req.headers && (req.headers['x-ms-client-principal'] || req.headers['X-MS-CLIENT-PRINCIPAL'])) || '';
  if (!header) return null;
  let json;
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  return json;
}

function isAdmin(req) {
  const principal = readAdminPrincipal(req);
  if (!principal) return false;
  if (String(principal.identityProvider).toLowerCase() !== 'github') return false;
  const userDetails = String(principal.userDetails || '').toLowerCase();
  return userDetails === ADMIN_GITHUB_USERNAME;
}

function verifyCronSecret(req) {
  const got = (req.headers && (req.headers['x-cron-secret'] || req.headers['X-Cron-Secret'])) || '';
  if (!got) return false;
  let expected;
  try {
    expected = getCronSecret();
  } catch {
    return false;
  }
  if (got.length !== expected.length) return false;
  return constantTimeEqual(got, expected);
}

// --- Generic ID generator -------------------------------------------------

function generateId(prefix = '') {
  const buf = crypto.randomBytes(12);
  const id = b64urlEncode(buf);
  return prefix ? `${prefix}_${id}` : id;
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SEC,
  signMagicToken,
  verifyMagicToken,
  issueSessionCookie,
  clearSessionCookie,
  verifySessionCookie,
  readAdminPrincipal,
  isAdmin,
  verifyCronSecret,
  generateId,
  constantTimeEqual
};
