'use strict';
// Spot test for api/_lib/http.js helpers.
// Verifies the shapes of guardMethodOrigin / readJsonBody / jsonOk / jsonError
// against the conventions documented in the module header.
//
// Run: node scripts/test-http-helpers.cjs

const Module = require('module');

const origLoad = Module._load;
const stubs = {
  './cors': {
    preflight: (req, allowList) => {
      if (req.method === 'OPTIONS') {
        return {
          handled: true,
          response: {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': req.headers.origin || '*',
              'Access-Control-Allow-Methods': allowList,
              'Access-Control-Allow-Headers': 'content-type'
            }
          }
        };
      }
      return {
        handled: false,
        cors: { 'Access-Control-Allow-Origin': req.headers.origin || '*' },
        origin: req.headers.origin || ''
      };
    },
    isAllowedOrigin: (origin) => origin === 'https://example.com',
  },
};
Module._load = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, parent, ...rest);
};

const http = require('../api/_lib/http.js');

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`); }
}

// ---- guardMethodOrigin ----
let r = http.guardMethodOrigin(
  { method: 'OPTIONS', headers: { origin: 'https://example.com' } }, 'POST');
assert('OPTIONS preflight handled', r.handled === true && r.response.status === 204);

r = http.guardMethodOrigin(
  { method: 'GET', headers: { origin: 'https://example.com' } }, 'POST');
assert('GET on POST-only -> 405', r.handled === true && r.response.status === 405
  && r.response.body.error === 'method_not_allowed');

r = http.guardMethodOrigin(
  { method: 'POST', headers: { origin: 'https://evil.example' } }, 'POST');
assert('disallowed origin -> 403', r.handled === true && r.response.status === 403
  && r.response.body.error === 'origin_not_allowed');

r = http.guardMethodOrigin(
  { method: 'POST', headers: { origin: 'https://example.com' } }, 'POST');
assert('POST allowed -> proceed', r.handled === false && r.cors && r.origin === 'https://example.com');

r = http.guardMethodOrigin(
  { method: 'PUT', headers: { origin: 'https://example.com' } }, ['PUT', 'PATCH']);
assert('PUT in [PUT,PATCH] -> proceed', r.handled === false);

r = http.guardMethodOrigin(
  { method: 'GET', headers: { origin: 'https://example.com' } }, ['PUT', 'PATCH']);
assert('GET on [PUT,PATCH] -> 405', r.handled === true && r.response.status === 405);

// ---- readJsonBody ----
let b = http.readJsonBody({ body: { x: 1 }, rawBody: '{"x":1}' });
assert('parsed object body', b.value && b.value.x === 1 && !b.error);

b = http.readJsonBody({ body: '{"x":2}', rawBody: '{"x":2}' });
assert('string body parses', b.value && b.value.x === 2);

b = http.readJsonBody({ body: 'not json', rawBody: 'not json' });
assert('non-JSON string body -> invalid_json', b.error === 'invalid_json');

b = http.readJsonBody({ body: '', rawBody: '' });
assert('empty string body -> empty_body', b.error === 'empty_body');

b = http.readJsonBody({ body: undefined, rawBody: undefined });
assert('null body -> empty_body', b.error === 'empty_body');

b = http.readJsonBody({ body: 'a'.repeat(1000), rawBody: 'a'.repeat(100_000) },
  { maxBytes: 1024 });
assert('oversize body -> payload_too_large', b.error === 'payload_too_large');

// ---- jsonOk / jsonError ----
let res = http.jsonOk({ ok: true, foo: 1 }, { 'Access-Control-Allow-Origin': '*' });
assert('jsonOk status 200', res.status === 200);
assert('jsonOk merges cors + content-type + no-store',
  res.headers['Access-Control-Allow-Origin'] === '*'
  && res.headers['Content-Type'] === 'application/json'
  && res.headers['Cache-Control'] === 'no-store');
assert('jsonOk body passes through', res.body.foo === 1);

res = http.jsonOk(null, { 'Access-Control-Allow-Origin': '*' });
assert('jsonOk null body defaults to {ok:true}', res.body && res.body.ok === true);

res = http.jsonError(400, 'invalid_json', { 'Access-Control-Allow-Origin': '*' });
assert('jsonError status passes through', res.status === 400);
assert('jsonError uses { error } shape', res.body.error === 'invalid_json' && !('reason' in res.body));

res = http.jsonError(503, 'storage_unavailable', null, { 'Retry-After': '5' });
assert('jsonError merges extraHeaders',
  res.headers['Retry-After'] === '5' && res.headers['Content-Type'] === 'application/json');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
