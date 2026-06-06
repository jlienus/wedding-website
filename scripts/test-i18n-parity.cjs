'use strict';
// Verifies en.json and es.json have identical key sets.
//
// A missing translation in either locale falls back to the key string,
// which in production looks like raw dot-path text leaking onto the
// page. Failing this in CI is much cheaper than catching it in QA.
//
// Run: node scripts/test-i18n-parity.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'src', 'i18n');

function loadLocale(name) {
  const file = path.join(ROOT, `${name}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${name}.json failed to parse: ${e.message}`);
  }
}

// Flatten a nested translation object into dot-path keys.
// e.g. { rsvp: { login: { title: '...' } } } -> ['rsvp.login.title']
function flatten(obj, prefix, out) {
  out = out || [];
  prefix = prefix || '';
  if (obj === null || typeof obj !== 'object') {
    out.push(prefix);
    return out;
  }
  if (Array.isArray(obj)) {
    // Arrays count as leaf values addressed by index — but in this
    // codebase we use strings throughout, not arrays, so treat
    // array-shaped values as leaves.
    out.push(prefix);
    return out;
  }
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    const next = prefix ? `${prefix}.${k}` : k;
    flatten(obj[k], next, out);
  }
  return out;
}

function main() {
  const en = loadLocale('en');
  const es = loadLocale('es');

  const enKeys = new Set(flatten(en));
  const esKeys = new Set(flatten(es));

  const missingInEs = [...enKeys].filter(k => !esKeys.has(k)).sort();
  const missingInEn = [...esKeys].filter(k => !enKeys.has(k)).sort();

  if (missingInEs.length === 0 && missingInEn.length === 0) {
    console.log(`PASS  i18n parity (${enKeys.size} keys per locale)`);
    process.exit(0);
  }

  console.log('FAIL  i18n keys out of sync');
  console.log(`  en.json: ${enKeys.size} keys`);
  console.log(`  es.json: ${esKeys.size} keys`);
  if (missingInEs.length) {
    console.log(`\n  Missing in es.json (${missingInEs.length}):`);
    for (const k of missingInEs) console.log(`    - ${k}`);
  }
  if (missingInEn.length) {
    console.log(`\n  Missing in en.json (${missingInEn.length}):`);
    for (const k of missingInEn) console.log(`    - ${k}`);
  }
  process.exit(1);
}

main();
