'use strict';

const crypto = require('crypto');

const MAGIC_PURPOSE = 'rsvp-magic-v1';
const SESSION_PURPOSE = 'rsvp-session-v1';
const SESSION_COOKIE_NAME = 'rsvp_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 60; // 60 days, covers post-deadline extension to Jan 15
const SIG_LEN_CHARS = 22; // ~128 bits of base64url

// Admin email magic-link constants. Separate from the RSVP guest magic
// links so a leaked guest secret can never authenticate as an admin and
// vice-versa.
const ADMIN_MAGIC_PURPOSE = 'admin-magic-v1';
const ADMIN_SESSION_PURPOSE = 'admin-session-v1';
const ADMIN_SESSION_COOKIE_NAME = 'admin_session';
const ADMIN_SESSION_MAX_AGE_SEC = 60 * 60 * 2;   // 2 hours -- tight for an admin
const ADMIN_MAGIC_MAX_AGE_SEC = 60 * 10;         // 10 minutes
const ADMIN_NONCE_BYTES = 16;                    // 128 bits of base64url

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
// Format: <inviteId>.<sig>
// Used in SMS links: /api/rsvp/magic?t=<inviteId>.<sig>

function signMagicToken(inviteId) {
  const sig = hmacSign(getMagicSecret(), MAGIC_PURPOSE, inviteId);
  return `${inviteId}.${sig}`;
}

function verifyMagicToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const inviteId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(inviteId)) return null;
  if (sig.length !== SIG_LEN_CHARS) return null;
  const expected = hmacSign(getMagicSecret(), MAGIC_PURPOSE, inviteId);
  return constantTimeEqual(sig, expected) ? inviteId : null;
}

// --- Session cookies ------------------------------------------------------
// Format: <inviteId>.<issuedAtMs>.<sig>
// Issued after successful name lookup or magic-link click.
// HttpOnly + Secure + SameSite=Lax cookie sent to /api/rsvp/submit.

function signSession(inviteId, issuedAtMs) {
  const payload = `${inviteId}|${issuedAtMs}`;
  return hmacSign(getSessionSecret(), SESSION_PURPOSE, payload);
}

function issueSessionCookie(inviteId, opts = {}) {
  const now = Date.now();
  const sig = signSession(inviteId, now);
  const value = `${inviteId}.${now}.${sig}`;
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
  const [inviteId, issuedAtStr, sig] = parts;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(inviteId)) return null;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
  const ageMs = Date.now() - issuedAt;
  const limit = (maxAgeSec || SESSION_MAX_AGE_SEC) * 1000;
  if (ageMs < 0 || ageMs > limit) return null;
  const expected = signSession(inviteId, issuedAt);
  return constantTimeEqual(sig, expected) ? { inviteId, issuedAt } : null;
}

// --- Admin auth (SWA principal) -------------------------------------------
// SWA forwards an x-ms-client-principal header (base64 JSON) when the user
// has authenticated via a configured provider. The repo owner (jlienus) logs
// in via the built-in GitHub provider. Defense in depth alongside route
// config.
//
// Layered auth model:
//   isAdmin(req) returns true if EITHER
//     (a) the request carries a valid SWA principal whose identityProvider
//         is 'github' AND userDetails matches ADMIN_GITHUB_USERNAME, OR
//     (b) the request carries a valid admin_session cookie whose embedded
//         email is in the allowlist (ADMIN_EMAIL_ALLOWLIST env var).
//
// Email-path login is implemented in api/admin_login_* via 10-minute single-
// use magic tokens (see signAdminMagicToken / verifyAdminMagicToken below)
// and the 2-hour admin_session cookie (issueAdminSessionCookie).

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

function isAdminGitHub(req) {
  const principal = readAdminPrincipal(req);
  if (!principal) return false;
  if (String(principal.identityProvider).toLowerCase() !== 'github') return false;
  const userDetails = String(principal.userDetails || '').toLowerCase();
  return userDetails === ADMIN_GITHUB_USERNAME;
}

function isAdminEmailSession(req) {
  const session = verifyAdminSession(req);
  if (!session) return false;
  return isAdminEmail(session.email);
}

function isAdmin(req) {
  if (isAdminGitHub(req)) return true;
  if (isAdminEmailSession(req)) return true;
  return false;
}

// Returns a stable, low-PII identity descriptor for the currently authed
// admin, suitable for use as the `actor` field on audit-log events.
// Falls back to '' if neither path is authenticated.
function readAdminActor(req) {
  const principal = readAdminPrincipal(req);
  if (principal && String(principal.identityProvider).toLowerCase() === 'github') {
    const userDetails = String(principal.userDetails || '').toLowerCase();
    if (userDetails === ADMIN_GITHUB_USERNAME) {
      return `github:${userDetails}`;
    }
  }
  const session = verifyAdminSession(req);
  if (session && isAdminEmail(session.email)) {
    return `email:${session.email}`;
  }
  return '';
}

// --- Admin email magic-link + session -------------------------------------
//
// Magic token shape: <emailB64>.<expMsB64>.<nonceB64>.<sig>
//   emailB64   base64url(<lowercased email>) -- carries identity inside the
//              signed payload; verify reads it back out and re-checks the
//              allowlist so removing someone from ADMIN_EMAIL_ALLOWLIST
//              immediately invalidates any still-live links.
//   expMsB64   base64url of the ASCII decimal expiry epoch ms
//   nonceB64   16 random bytes; storage.claimAdminNonce makes it single-use
//   sig        22 chars of base64url(HMAC-SHA256(secret, purpose | payload))
//
// Session cookie shape: admin_session=<emailB64>.<issuedAtMsB64>.<sig>
//   HttpOnly + Secure + SameSite=Strict, MaxAge=2h.
//
// Secrets are intentionally distinct from the RSVP-guest secrets (different
// scope, different blast radius). ADMIN_SESSION_SECRET does NOT fall back to
// ADMIN_MAGIC_SECRET because the two protect different surface areas.

function getAdminMagicSecret() {
  const s = process.env.ADMIN_MAGIC_SECRET;
  if (!s || s.length < 32) {
    throw new Error('CONFIG_MISSING_ADMIN_MAGIC_SECRET');
  }
  return s;
}

function getAdminSessionSecret() {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('CONFIG_MISSING_ADMIN_SESSION_SECRET');
  }
  return s;
}

function getAdminEmailAllowlist() {
  const raw = process.env.ADMIN_EMAIL_ALLOWLIST || '';
  if (!raw.trim()) {
    throw new Error('CONFIG_MISSING_ADMIN_EMAIL_ALLOWLIST');
  }
  const out = new Set();
  for (const part of raw.split(',')) {
    const v = part.trim().toLowerCase();
    if (v) out.add(v);
  }
  return Array.from(out);
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

// RFC-5321-lite. Accepts the shapes Gmail/Outlook actually send; rejects
// anything with whitespace, multiple @ symbols, or no TLD. Length cap keeps
// the email out of the absurd-input range that breaks downstream renderers.
function isLikelyEmail(s) {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  if (v.length === 0 || v.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isAdminEmail(email) {
  const v = normalizeEmail(email);
  if (!v) return false;
  let allow;
  try { allow = getAdminEmailAllowlist(); }
  catch { return false; }
  // Constant-time per-entry compare. Allowlist is tiny (1-5 entries) so the
  // O(n) walk is irrelevant. Lengths-differ short-circuit is safe to expose
  // (no secret length to leak).
  let hit = false;
  for (const entry of allow) {
    if (entry.length === v.length && constantTimeEqual(entry, v)) {
      hit = true;
    }
  }
  return hit;
}

function b64urlString(s) {
  return b64urlEncode(Buffer.from(String(s), 'utf8'));
}

function b64urlDecodeToString(s) {
  // Restore padding so Buffer.from('base64') accepts it.
  let pad = s.replace(/-/g, '+').replace(/_/g, '/');
  while (pad.length % 4) pad += '=';
  return Buffer.from(pad, 'base64').toString('utf8');
}

function signAdminMagicToken(email, opts = {}) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('email required');
  const ttlSec = opts.maxAgeSec || ADMIN_MAGIC_MAX_AGE_SEC;
  const expiresAtMs = opts.nowMs ? opts.nowMs + ttlSec * 1000 : Date.now() + ttlSec * 1000;
  const nonceB64 = b64urlEncode(crypto.randomBytes(ADMIN_NONCE_BYTES));
  const emailB64 = b64urlString(e);
  const expB64 = b64urlString(String(expiresAtMs));
  const payload = `${emailB64}.${expB64}.${nonceB64}`;
  const sig = hmacSign(getAdminMagicSecret(), ADMIN_MAGIC_PURPOSE, payload);
  return {
    token: `${payload}.${sig}`,
    expiresAtMs,
    // base64url-of-bytes (URL-safe) so storage rowKey is well-formed
    nonce: nonceB64,
    email: e
  };
}

// Pure cryptographic + structural verification. Does NOT consult the
// nonce table; the caller is responsible for claiming the nonce on top of
// this (see api/admin_login_verify). Returns null on any failure (don't
// distinguish reasons to callers from outside the auth module -- enumeration
// hazard).
function verifyAdminMagicToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [emailB64, expB64, nonceB64, sig] = parts;
  if (sig.length !== SIG_LEN_CHARS) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(emailB64)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(expB64)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(nonceB64)) return null;
  const payload = `${emailB64}.${expB64}.${nonceB64}`;
  let expected;
  try {
    expected = hmacSign(getAdminMagicSecret(), ADMIN_MAGIC_PURPOSE, payload);
  } catch {
    return null;
  }
  if (!constantTimeEqual(sig, expected)) return null;
  let email = '';
  let expiresAtMs = 0;
  try {
    email = b64urlDecodeToString(emailB64).toLowerCase();
    expiresAtMs = Number(b64urlDecodeToString(expB64));
  } catch {
    return null;
  }
  if (!isLikelyEmail(email)) return null;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return null;
  if (Date.now() > expiresAtMs) return null;
  return { email, expiresAtMs, nonceHash: nonceB64 };
}

function signAdminSession(email, issuedAtMs) {
  const e = normalizeEmail(email);
  const emailB64 = b64urlString(e);
  const issuedB64 = b64urlString(String(issuedAtMs));
  const payload = `${emailB64}.${issuedB64}`;
  return hmacSign(getAdminSessionSecret(), ADMIN_SESSION_PURPOSE, payload);
}

function issueAdminSessionCookie(email, opts = {}) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('email required');
  const now = opts.nowMs || Date.now();
  const sig = signAdminSession(e, now);
  const value = `${b64urlString(e)}.${b64urlString(String(now))}.${sig}`;
  const maxAge = opts.maxAgeSec || ADMIN_SESSION_MAX_AGE_SEC;
  const attrs = [
    `${ADMIN_SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAge}`
  ];
  return attrs.join('; ');
}

function clearAdminSessionCookie() {
  return [
    `${ADMIN_SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0'
  ].join('; ');
}

function verifyAdminSession(req, maxAgeSec) {
  const raw = readCookie(req, ADMIN_SESSION_COOKIE_NAME);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [emailB64, issuedB64, sig] = parts;
  if (sig.length !== SIG_LEN_CHARS) return null;
  let email = '';
  let issuedAt = 0;
  try {
    email = b64urlDecodeToString(emailB64).toLowerCase();
    issuedAt = Number(b64urlDecodeToString(issuedB64));
  } catch {
    return null;
  }
  if (!isLikelyEmail(email)) return null;
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
  const ageMs = Date.now() - issuedAt;
  const limit = (maxAgeSec || ADMIN_SESSION_MAX_AGE_SEC) * 1000;
  if (ageMs < 0 || ageMs > limit) return null;
  let expected;
  try {
    expected = signAdminSession(email, issuedAt);
  } catch {
    return null;
  }
  if (!constantTimeEqual(sig, expected)) return null;
  return { email, issuedAt };
}

function verifyCronSecret(req) {
  return _verifyHeaderSecret(req, ['x-cron-secret', 'X-Cron-Secret'], getCronSecret);
}

function getBackupSecret() {
  const s = process.env.RSVP_BACKUP_SECRET;
  if (!s || s.length < 32) {
    throw new Error('CONFIG_MISSING_RSVP_BACKUP_SECRET');
  }
  return s;
}

function verifyBackupSecret(req) {
  return _verifyHeaderSecret(req, ['x-backup-secret', 'X-Backup-Secret'], getBackupSecret);
}

function getInternalSecret() {
  const s = process.env.RSVP_INTERNAL_SECRET;
  if (!s || s.length < 32) {
    throw new Error('CONFIG_MISSING_RSVP_INTERNAL_SECRET');
  }
  return s;
}

function verifyInternalSecret(req) {
  return _verifyHeaderSecret(req, ['x-internal-secret', 'X-Internal-Secret'], getInternalSecret);
}

function _verifyHeaderSecret(req, headerNames, getter) {
  let got = '';
  for (const h of headerNames) {
    if (req.headers && req.headers[h]) { got = req.headers[h]; break; }
  }
  if (!got) return false;
  let expected;
  try {
    expected = getter();
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
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_MAX_AGE_SEC,
  ADMIN_MAGIC_MAX_AGE_SEC,
  signMagicToken,
  verifyMagicToken,
  issueSessionCookie,
  clearSessionCookie,
  verifySessionCookie,
  readAdminPrincipal,
  isAdmin,
  isAdminGitHub,
  isAdminEmailSession,
  readAdminActor,
  // admin email magic-link
  isLikelyEmail,
  normalizeEmail,
  getAdminEmailAllowlist,
  isAdminEmail,
  signAdminMagicToken,
  verifyAdminMagicToken,
  issueAdminSessionCookie,
  clearAdminSessionCookie,
  verifyAdminSession,
  verifyCronSecret,
  verifyBackupSecret,
  verifyInternalSecret,
  generateId,
  constantTimeEqual
};
