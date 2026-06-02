'use strict';

const crypto = require('crypto');

const IP_HASH_SALT = process.env.IP_HASH_SALT || process.env.WEBSITE_SITE_NAME || 'wedding-default-salt';

// Per-instance in-memory rate-limit counters. Cleared on cold start.
// Map<bucketKey, Map<ipKey, {timestamps: number[]}>>
const buckets = new Map();

function pruneBucket(bucket, windowMs, now) {
  for (const [ip, entry] of bucket) {
    entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
    if (entry.timestamps.length === 0) {
      bucket.delete(ip);
    }
  }
}

function check(bucketKey, ip, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = new Map();
    buckets.set(bucketKey, bucket);
  }
  if (Math.random() < 0.05) pruneBucket(bucket, windowMs, now);
  const entry = bucket.get(ip) || { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((ts) => now - ts < windowMs);
  if (entry.timestamps.length >= limit) {
    const oldest = entry.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { ok: false, retryAfter: retryAfterSec };
  }
  entry.timestamps.push(now);
  bucket.set(ip, entry);
  return { ok: true };
}

function clientIp(req) {
  const fwd = (req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'])) || '';
  return fwd.split(',')[0].trim() || 'unknown';
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip + '|' + IP_HASH_SALT).digest('hex').slice(0, 10);
}

module.exports = {
  check,
  clientIp,
  hashIp
};
