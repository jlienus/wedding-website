'use strict';

// Pure unit tests for storage.maskPhone(). No Azure required.

const assert = require('assert');

// maskPhone is exported off storage.js but storage.js wants RSVP_FIELD_KEY_*
// env vars at module-load time only when getClients() is called. We only
// touch the pure helper, so set a throwaway connection just to satisfy any
// lazy import-time checks.
process.env.RSVP_STORAGE_CONNECTION = process.env.RSVP_STORAGE_CONNECTION ||
  'DefaultEndpointsProtocol=https;AccountName=fake;AccountKey=AAAA;EndpointSuffix=core.windows.net';

const { maskPhone } = require('../api/_lib/storage');

const cases = [
  // [label,                       input,                expected]
  ['empty string -> empty',        '',                   ''],
  ['null -> empty',                null,                 ''],
  ['undefined -> empty',           undefined,            ''],
  ['non-string number -> empty',   12345,                ''],
  ['E.164 US -> ***last4',         '+15551234567',       '***4567'],
  ['10-digit US -> ***last4',      '5551234567',         '***4567'],
  ['formatted US -> ***last4',     '(555) 123-4567',     '***4567'],
  ['intl -> ***last4',             '+593987654321',      '***4321'],
  ['3 digits -> stars',            '123',                '*****'],
  ['mixed garbage with 4 digits',  'abc1234xyz',         '***1234'],
  ['already masked -> unchanged',  '***4567',            '***4567'],
  ['idempotent on stars-only',     '*****',              '*****']
];

let pass = 0, fail = 0;
for (const [label, input, expected] of cases) {
  const got = maskPhone(input);
  if (got === expected) {
    pass += 1;
    console.log(`  PASS  ${label}  (${JSON.stringify(input)} -> ${JSON.stringify(got)})`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${label}  input=${JSON.stringify(input)}  expected=${JSON.stringify(expected)}  got=${JSON.stringify(got)}`);
  }
}

console.log('---------------------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
