'use strict';

const ALLOWED_ORIGINS = new Set([
  'https://johnanddianaswedding.com',
  'https://www.johnanddianaswedding.com',
  'http://127.0.0.1:4321',
  'http://localhost:4321',
  'http://127.0.0.1:4280',
  'http://localhost:4280'
]);

function corsHeaders(origin, methods = 'POST, OPTIONS') {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://johnanddianaswedding.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.has(origin);
}

function preflight(req, methods) {
  const origin = (req.headers && (req.headers.origin || req.headers.Origin)) || '';
  const cors = corsHeaders(origin, methods);
  if (req.method === 'OPTIONS') {
    return { handled: true, response: { status: 204, headers: cors } };
  }
  return { handled: false, cors, origin };
}

module.exports = {
  ALLOWED_ORIGINS,
  corsHeaders,
  isAllowedOrigin,
  preflight
};
