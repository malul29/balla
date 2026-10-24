const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hakKomisi, ringkas } = require('../lib/komisi');

test('commission is a percentage of the money received, never above what is due', () => {
  assert.deepEqual(hakKomisi(2.5, 6000000, 26000000), { dasar: 6000000, hak: 150000 });
  assert.deepEqual(hakKomisi(2.5, 30000000, 26000000), { dasar: 26000000, hak: 650000 }, 'overpayment does not raise it');
  assert.deepEqual(hakKomisi(2.5, 0, 26000000), { dasar: 0, hak: 0 });
  assert.deepEqual(hakKomisi(0, 5000000, 5000000), { dasar: 5000000, hak: 0 });
  assert.deepEqual(hakKomisi('x', 'y', null), { dasar: 0, hak: 0 }, 'junk is zero');
  assert.equal(hakKomisi(1, 333, 1000).hak, 3, 'rounded to whole rupiah');
});

test('summary per sales person: earned minus paid out, negative when paid out too much', () => {
  const s = ringkas(
    [{ sales_id: 1, rate: 2, dibayar: 10000000, tagihan: 20000000 }, { sales_id: 1, rate: 1, dibayar: 1000000, tagihan: 1000000 }, { sales_id: 2, rate: 2, dibayar: 0, tagihan: 5 }],
    [{ sales_id: 1, jumlah: 100000 }, { sales_id: 3, jumlah: 50000 }]);
  assert.deepEqual(s.get(1), { sales_id: 1, unit: 2, dasar: 11000000, hak: 210000, sudah: 100000, sisa: 110000 });
  assert.equal(s.get(2).hak, 0);
  assert.equal(s.get(3).sisa, -50000, 'paid out with nothing earned shows as a negative balance');
});
