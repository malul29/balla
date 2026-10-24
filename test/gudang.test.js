const { test } = require('node:test');
const assert = require('node:assert/strict');
const { qty3, biayaKeluar, nilaiMasuk } = require('../lib/gudang');

test('quantities are rounded to 3 decimals and accept a decimal comma', () => {
  assert.equal(qty3('2,5'), 2.5); assert.equal(qty3('0.12345'), 0.123); assert.equal(qty3(10), 10);
  assert.ok(Number.isNaN(qty3('abc'))); assert.ok(Number.isNaN(qty3('')) || qty3('') === 0);
});

test('issuing costs the moving average; the last unit takes the remaining value', () => {
  assert.equal(biayaKeluar(100, 5000000, 10), 500000);
  assert.equal(biayaKeluar(3, 100, 1), 33);
  assert.equal(biayaKeluar(3, 100, 3), 100, 'emptying the stock leaves no value behind');
  assert.equal(biayaKeluar(3, 100, 5), 100, 'never more than the stock value');
  assert.equal(biayaKeluar(0, 0, 1), 0); assert.equal(biayaKeluar(10, 100, 0), 0);
});

test('receiving uses the unit price, or the current average when the price is unknown', () => {
  assert.equal(nilaiMasuk(0, 0, 10, 65000), 650000);
  assert.equal(nilaiMasuk(100, 5000000, 10, null), 500000, 'average 50.000');
  assert.equal(nilaiMasuk(0, 0, 10, null), 0, 'nothing to average from');
  assert.equal(nilaiMasuk(10, 100, 2, 0), 0, 'a free delivery is worth 0, not the average');
});
