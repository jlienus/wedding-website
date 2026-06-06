'use strict';

// HTTP helpers for Azure Functions handlers.
//
// Centralizes the per-endpoint boilerplate that was previously copy-pasted
// across ~20 functions with subtle inconsistencies (e.g. `'method_not_allowed'`
// vs `'Method not allowed'`, `error: '...'` vs `ok: false, reason: '...'`).
//
// USAGE — migration is intentionally incremental. Do NOT bulk-migrate all
// endpoints in a single commit. Migrate one endpoint, ship + smoke-test, then
// migrate the next. The reason: the inconsistencies in the legacy boilerplate
// are absorbed by the Astro client today, and a careless bulk change could
// regress a code path that depends on the existing error string shape.
//
// Recommended pattern for migrated endpoints:
//
//   const http = require('../_lib/http');
//
//   module.exports = async function (context, req) {
//     const gate = http.guardMethodOrigin(req, 'POST');
//     if (gate.handled) { context.res = gate.response; return; }
//     const { cors } = gate;
//
//     const body = http.readJsonBody(req);
//     if (body.error) {
//       context.res = http.jsonError(400, body.error, cors);
//       return;
//     }
//     // ...do work...
//     context.res = http.jsonOk({ ok: true }, cors);
//   };
//
// Conventions standardized here:
//   * `method_not_allowed` (lowercase, snake_case) — never `'Method not allowed'`
//   * `origin_not_allowed` (lowercase, snake_case)
//   * `invalid_json` (lowercase, snake_case) for body parse failures
//   * `payload_too_large` (lowercase, snake_case) for oversize bodies
//   * Error responses use `{ error: '<snake_case_reason>' }`
//   * Success/no-error responses use `{ ok: true, ... }`
//   * All JSON responses include `Cache-Control: no-store`
//   * Preflight (OPTIONS) handled by the underlying cors module

const { preflight, isAllowedOrigin } = require('./cors');

const MAX_BODY_BYTES_DEFAULT = 64 * 1024;

// Combines preflight + method-allowed + origin-allowed checks. Returns one
// of two shapes:
//   { handled: true,  response: { status, headers, body } }  -- caller should set context.res and return
//   { handled: false, cors, origin }                          -- caller should proceed
function guardMethodOrigin(req, allowedMethods) {
  const methods = Array.isArray(allowedMethods) ? allowedMethods : [allowedMethods];
  const allowList = [...methods, 'OPTIONS'].join(', ');
  const pre = preflight(req, allowList);
  if (pre.handled) return { handled: true, response: pre.response };
  const { cors, origin } = pre;

  if (!methods.includes(req.method)) {
    return {
      handled: true,
      response: {
        status: 405,
        headers: { ...cors, 'Allow': allowList },
        body: { error: 'method_not_allowed' }
      }
    };
  }
  if (!isAllowedOrigin(origin)) {
    return {
      handled: true,
      response: {
        status: 403,
        headers: cors,
        body: { error: 'origin_not_allowed' }
      }
    };
  }
  return { handled: false, cors, origin };
}

// Safely parse a JSON request body. Returns one of:
//   { value: <parsed object> }
//   { error: 'invalid_json' }     -- body wasn't JSON
//   { error: 'payload_too_large' } -- body exceeded maxBytes
//   { error: 'empty_body' }       -- body was missing/empty
//
// Azure Functions on the Node.js worker auto-parses JSON when content-type is
// application/json and the body is well-formed, leaving `req.body` as an
// object. When it can't parse, `req.body` is the raw string (or undefined).
function readJsonBody(req, opts) {
  const maxBytes = (opts && opts.maxBytes) || MAX_BODY_BYTES_DEFAULT;
  const raw = req && req.rawBody;
  if (typeof raw === 'string' && raw.length > maxBytes) {
    return { error: 'payload_too_large' };
  }
  if (req && req.body && typeof req.body === 'object') {
    return { value: req.body };
  }
  if (typeof req.body === 'string') {
    if (!req.body.trim()) return { error: 'empty_body' };
    try {
      return { value: JSON.parse(req.body) };
    } catch {
      return { error: 'invalid_json' };
    }
  }
  if (req.body == null) return { error: 'empty_body' };
  return { error: 'invalid_json' };
}

function jsonOk(body, cors, extraHeaders) {
  return {
    status: 200,
    headers: {
      ...(cors || {}),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {})
    },
    body: body || { ok: true }
  };
}

function jsonError(status, reason, cors, extraHeaders) {
  return {
    status,
    headers: {
      ...(cors || {}),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {})
    },
    body: { error: String(reason || 'unknown_error') }
  };
}

module.exports = {
  guardMethodOrigin,
  readJsonBody,
  jsonOk,
  jsonError
};
