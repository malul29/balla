// Payment tracking: match the receipts (kwitansi) of a unit against the payment schedule of its SKU/SPU.
// Pure functions, no database: the store feeds them rows and receipts, the tests feed them literals.
//
// A receipt names what it pays for (`untuk`): reservasi, booking, dp ke-N (= instalment N), or pelunasan.
// It is allocated to that schedule row first; what does not fit (a row already full, or a receipt that names no
// existing row) is spread over the earliest rows that are still open, so money is never lost or double counted.

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const day = (iso) => Date.parse(String(iso) + 'T00:00:00Z');
const daysBetween = (a, b) => Math.round((day(b) - day(a)) / 864e5);
const isISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Which schedule row a receipt pays for (null when it names none).
function keyOfReceipt(d) {
  const untuk = String((d && d.untuk) || '');
  if (untuk === 'dp') { const n = parseInt(String(d.dpKe || '').replace(/\D/g, ''), 10); return n > 0 ? 'cicilan' + n : null; }
  return ['reservasi', 'booking', 'pelunasan'].includes(untuk) ? untuk : null;
}

// rows:     [{ key, label, tanggal (due date), jumlah }]   — Schedule.rows() of the SKU/SPU
// receipts: [{ key, jumlah, tanggal, no }]
// today:    'YYYY-MM-DD'
function allocate(rows, receipts, today) {
  const list = rows.map((r) => ({ key: r.key, label: r.label, due: isISO(r.tanggal) ? r.tanggal : '', jumlah: num(r.jumlah), dibayar: 0, kwitansi: [] }));
  const byKey = new Map(list.map((r) => [r.key, r]));
  const ordered = [...receipts].map((k, i) => ({ ...k, _i: i })).sort((a, b) => String(a.tanggal || '').localeCompare(String(b.tanggal || '')) || a._i - b._i);

  const pool = [];
  const put = (row, k, amount) => { row.dibayar += amount; row.kwitansi.push({ no: k.no, tanggal: k.tanggal || '', jumlah: amount }); };
  for (const k of ordered) {
    const amount = num(k.jumlah);
    if (!amount) continue;
    const row = k.key ? byKey.get(k.key) : null;
    if (!row) { pool.push({ ...k, sisa: amount }); continue; }
    const take = Math.min(Math.max(0, row.jumlah - row.dibayar), amount);
    if (take) put(row, k, take);
    if (amount > take) pool.push({ ...k, sisa: amount - take });
  }
  for (const p of pool) {
    for (const row of list) {
      if (!p.sisa) break;
      const take = Math.min(Math.max(0, row.jumlah - row.dibayar), p.sisa);
      if (take) { put(row, p, take); p.sisa -= take; }
    }
  }
  const lebih = pool.reduce((a, p) => a + p.sisa, 0); // paid beyond everything the schedule asks for

  for (const r of list) {
    r.sisa = Math.max(0, r.jumlah - r.dibayar);
    r.status = r.jumlah > 0 && r.sisa === 0 ? 'lunas' : r.dibayar > 0 ? 'sebagian' : 'belum';
    r.hariTelat = r.due && r.sisa > 0 && isISO(today) && r.due < today ? daysBetween(r.due, today) : 0;
  }
  const tagihan = list.reduce((a, r) => a + r.jumlah, 0);
  const dibayar = list.reduce((a, r) => a + r.dibayar, 0) + lebih;
  const open = list.filter((r) => r.sisa > 0);
  const next = [...open].sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))[0] || null;
  return {
    rows: list, tagihan, dibayar, lebih,
    sisa: list.reduce((a, r) => a + r.sisa, 0),
    telat: list.reduce((a, r) => a + (r.hariTelat ? r.sisa : 0), 0),
    hariTelat: Math.max(0, ...list.map((r) => r.hariTelat)),
    persen: tagihan ? Math.min(100, Math.round((dibayar / tagihan) * 100)) : 0,
    next: next && { key: next.key, label: next.label, due: next.due, sisa: next.sisa },
  };
}

module.exports = { allocate, keyOfReceipt };
