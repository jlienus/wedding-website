function formatUsPhone(raw) {
  const trimmed = (raw || '').replace(/\s*(?:ext\.?|x|#|,|;)\s*\d+.*$/i, '');
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length === 0) return '';
  if (digits.length <= 3) return '(' + digits;
  if (digits.length <= 6) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
  return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + ' - ' + digits.slice(6, 10);
}
const cases = [
  ['5559876543', '(555) 987 - 6543'],
  ['1-555-987-6543', '(555) 987 - 6543'],
  ['202', '(202'],
  ['2026', '(202) 6'],
  ['+1 (555) 987.6543 ext 123', '(555) 987 - 6543'],
  ['+1 (555) 987.6543 x99', '(555) 987 - 6543'],
  ['555-987-6543,8675', '(555) 987 - 6543'],
  ['555-987-6543#123', '(555) 987 - 6543'],
  ['abc555xyz987def6543', '(555) 987 - 6543'],
  ['15559876543', '(555) 987 - 6543'],
  ['', ''],
  ['1', '(1'],
];
let pass = 0, fail = 0;
for (const [input, expected] of cases) {
  const actual = formatUsPhone(input);
  if (actual === expected) { pass++; console.log('PASS: "' + input + '" -> "' + actual + '"'); }
  else { fail++; console.log('FAIL: "' + input + '" -> "' + actual + '" (expected "' + expected + '")'); }
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
