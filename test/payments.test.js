const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allocate, keyOfReceipt } = require('../lib/payments');

const rows = [
  { key: 'reservasi', label: 'Reservasi', tanggal: '2026-10-01', jumlah: '1000000' },
  { key: 'booking', label: 'Booking Fee', tanggal: '2026-10-08', jumlah: '5000000' },
  { key: 'cicilan1', label: 'Uang Muka 1/2', tanggal: '2026-11-05', jumlah: '10000000' },
  { key: 'cicilan2', label: 'Uang Muka 2/2', tanggal: '2026-12-05', jumlah: '10000000' },
];
const rc = (key, jumlah, tanggal, no) => ({ key, jumlah, tanggal, no });

test('a receipt goes to the row it names', () => {
  const r = allocate(rows, [rc('reservasi', 1000000, '2026-10-01', 'K1'), rc('booking', 5000000, '2026-10-08', 'K2')], '2026-10-20');
  assert.deepEqual(r.rows.map((x) => x.status), ['lunas', 'lunas', 'belum', 'belum']);
  assert.equal(r.tagihan, 26000000); assert.equal(r.dibayar, 6000000); assert.equal(r.sisa, 20000000);
  assert.equal(r.persen, 23);
  assert.deepEqual(r.next, { key: 'cicilan1', label: 'Uang Muka 1/2', due: '2026-11-05', sisa: 10000000 });
});

test('overdue = unpaid remainder of a row whose due date has passed', () => {
  const r = allocate(rows, [rc('reservasi', 1000000, '2026-10-01', 'K1')], '2026-10-20');
  assert.equal(r.rows[1].hariTelat, 12, 'booking fee was due 8 Oct');
  assert.equal(r.rows[2].hariTelat, 0, 'not yet due');
  assert.equal(r.telat, 5000000); assert.equal(r.hariTelat, 12);
  const partial = allocate(rows, [rc('booking', 2000000, '2026-10-08', 'K2')], '2026-10-20');
  assert.equal(partial.rows[1].status, 'sebagian'); assert.equal(partial.rows[1].sisa, 3000000);
  assert.equal(partial.rows[1].hariTelat, 12, 'a part payment does not stop the clock on the rest');
});

test('on the due date itself nothing is late yet', () => {
  assert.equal(allocate(rows, [], '2026-10-08').rows[1].hariTelat, 0);
  assert.equal(allocate(rows, [], '2026-10-09').rows[1].hariTelat, 1);
});

test('an overpaid row spills into the next open rows; money beyond the schedule is "lebih"', () => {
  const r = allocate(rows, [rc('booking', 8000000, '2026-10-08', 'K2')], '2026-10-09');
  assert.equal(r.rows[1].dibayar, 5000000); assert.equal(r.rows[1].status, 'lunas');
  assert.equal(r.rows[0].dibayar, 1000000, 'the spill went to the earliest open row (reservasi)');
  assert.equal(r.rows[2].dibayar, 2000000);
  assert.equal(r.dibayar, 8000000);
  const all = allocate(rows, [rc('booking', 30000000, '2026-10-08', 'K9')], '2026-10-09');
  assert.equal(all.sisa, 0); assert.equal(all.lebih, 4000000); assert.equal(all.dibayar, 30000000);
});

test('a receipt that names no existing row is spread over the earliest open rows', () => {
  const r = allocate(rows, [rc('pelunasan', 6000000, '2026-10-08', 'K3'), rc(null, 500000, '2026-10-09', 'K4')], '2026-10-10');
  assert.equal(r.rows[0].dibayar, 1000000); assert.equal(r.rows[1].dibayar, 5000000); assert.equal(r.rows[2].dibayar, 500000);
  assert.equal(r.dibayar, 6500000);
});

test('the same receipts always give the same result, whatever order they arrive in', () => {
  const a = [rc('booking', 2000000, '2026-10-08', 'K1'), rc('booking', 4000000, '2026-10-12', 'K2')];
  const x = allocate(rows, a, '2026-10-20'), y = allocate(rows, [...a].reverse(), '2026-10-20');
  assert.deepEqual(x.rows.map((r) => r.dibayar), y.rows.map((r) => r.dibayar));
  assert.deepEqual(x.rows[1].kwitansi.map((k) => k.no), ['K1', 'K2']);
});

test('zero or junk amounts are ignored; rows without an amount never go overdue', () => {
  const r = allocate([{ key: 'booking', label: 'B', tanggal: '2026-01-01', jumlah: '' }], [rc('booking', 'abc', '2026-01-01', 'K')], '2026-12-01');
  assert.equal(r.tagihan, 0); assert.equal(r.dibayar, 0); assert.equal(r.rows[0].hariTelat, 0); assert.equal(r.persen, 0);
});

test('keyOfReceipt maps what a receipt says it is for to a schedule row', () => {
  assert.equal(keyOfReceipt({ untuk: 'booking' }), 'booking');
  assert.equal(keyOfReceipt({ untuk: 'reservasi' }), 'reservasi');
  assert.equal(keyOfReceipt({ untuk: 'pelunasan' }), 'pelunasan');
  assert.equal(keyOfReceipt({ untuk: 'dp', dpKe: '2' }), 'cicilan2');
  assert.equal(keyOfReceipt({ untuk: 'dp', dpKe: 'ke-3' }), 'cicilan3');
  assert.equal(keyOfReceipt({ untuk: 'dp', dpKe: '' }), null);
  assert.equal(keyOfReceipt({}), null);
});
