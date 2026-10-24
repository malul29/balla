const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ringkas, statusSpk, kategoriOK, isMonth } = require('../lib/keuangan');

test('roll-up: totals, balance, per month and per category, ignoring junk lines', () => {
  const r = ringkas([
    { tanggal: '2026-09-30', jenis: 'masuk', kategori: 'penjualan', jumlah: 6000000 },
    { tanggal: '2026-10-02', jenis: 'masuk', kategori: 'penjualan', jumlah: 4000000 },
    { tanggal: '2026-10-05', jenis: 'keluar', kategori: 'material', jumlah: 2500000 },
    { tanggal: '2026-10-09', jenis: 'keluar', kategori: 'material', jumlah: 500000 },
    { tanggal: '2026-10-09', jenis: 'keluar', kategori: 'gaji', jumlah: 'x' },
    { tanggal: '2026-10-09', jenis: 'lain', kategori: 'gaji', jumlah: 99 },
    { tanggal: '2026-10-10', jenis: 'keluar', kategori: 'gaji', jumlah: -5 },
  ]);
  assert.equal(r.masuk, 10000000); assert.equal(r.keluar, 3000000); assert.equal(r.saldo, 7000000);
  assert.deepEqual(r.perBulan.map((x) => [x.bulan, x.masuk, x.keluar, x.saldo]), [['2026-09', 6000000, 0, 6000000], ['2026-10', 4000000, 3000000, 1000000]]);
  assert.deepEqual(r.perKategori[0], { jenis: 'masuk', kategori: 'penjualan', jumlah: 10000000 });
  assert.equal(r.perKategori.find((k) => k.kategori === 'material').jumlah, 3000000);
});

test('categories belong to their direction; months are YYYY-MM', () => {
  assert.ok(kategoriOK('masuk', 'penjualan')); assert.ok(!kategoriOK('masuk', 'material')); assert.ok(kategoriOK('keluar', 'material')); assert.ok(!kategoriOK('keluar', 'toString'));
  assert.ok(isMonth('2026-10')); assert.ok(!isMonth('2026-13')); assert.ok(!isMonth('all'));
});

test('work order status: paid terms count, the rest is owed', () => {
  assert.deepEqual(statusSpk(100000000, [{ jumlah: 30000000, dibayar_tanggal: '2026-10-01' }, { jumlah: 70000000, dibayar_tanggal: null }]), { dibayar: 30000000, sisa: 70000000, persen: 30 });
  assert.deepEqual(statusSpk(100, []), { dibayar: 0, sisa: 100, persen: 0 });
});
