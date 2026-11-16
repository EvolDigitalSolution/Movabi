// Exact before/after check for the operator-captured ID manifest. No currency-to-country inference.
const assert = require('node:assert/strict');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const { before, after, intended } = JSON.parse(input);
    const ids = new Set(intended.map(r => r.id));
    assert.equal(ids.size, 4);
    assert.equal(before.length, after.length);
    const actual = new Map(after.map(r => [r.id, r]));
    for (const row of before) assert.deepStrictEqual(actual.get(row.id), ids.has(row.id) ? { ...row, country_code: 'GB' } : row);
    for (const row of intended) assert.deepStrictEqual(before.find(r => r.id === row.id), row);
    assert.equal(actual.get(intended.find(r => r.service_type === 'ride').id).minimum_fare, 3.35);
    console.log('ALL_PRICING_FIELDS_PRESERVED: only country_code changed on the four captured IDs; NG and all other rows identical');
  } catch (e) { console.error('PRICING_COMPARISON_FAILED: ' + e.message); process.exitCode = 1; }
});
