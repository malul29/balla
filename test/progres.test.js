const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STAGES, overall, addMonths, jadwalSerah, dendaSerah } = require('../lib/progres');

test('stage weights add up to 100 and overall progress is the weighted average', () => {
  assert.equal(STAGES.reduce((a, s) => a + s.bobot, 0), 100);
  assert.equal(overall({}), 0);
  assert.equal(overall(Object.fromEntries(STAGES.map((s) => [s.kode, 100]))), 100);
  assert.equal(overall({ pondasi: 100, struktur: 100 }), 40, '15 + 25');
  assert.equal(overall({ pondasi: 200, struktur: -5, atap: 'x' }), 15, 'junk is clamped or ignored');
});

test('months are added by calendar, clamping to the end of a short month', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-10-15', 12), '2027-10-15');
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
});

test('handover is due 12 months after the reference date, then 6 months of tolerance', () => {
  assert.deepEqual(jadwalSerah('2026-01-10', '2026-12-01'), { target: '2027-01-10', batas: '2027-07-10', hariTelat: 0 });
  assert.equal(jadwalSerah('2026-01-10', '2027-07-10').hariTelat, 0, 'the last tolerance day is not late yet');
  assert.equal(jadwalSerah('2026-01-10', '2027-07-20').hariTelat, 10);
  assert.deepEqual(jadwalSerah('', '2027-07-20'), { target: '', batas: '', hariTelat: 0 });
});

test('handover late fee: 1 o/oo of the unfinished work per day, at most 3%', () => {
  assert.equal(dendaSerah(100000000, 10), 1000000);
  assert.equal(dendaSerah(100000000, 30), 3000000);
  assert.equal(dendaSerah(100000000, 500), 3000000, 'capped at 3%');
  assert.equal(dendaSerah(0, 10), 0); assert.equal(dendaSerah('x', 'y'), 0);
});
