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
const addDays = (iso, n) => new Date(day(iso) + n * 864e5).toISOString().slice(0, 10);

// Late fee as in the terms (S&K Surat Pesanan 6a/6b): 1 o/oo (0.1%) per day of what is still unpaid, counted from the
// due date, for at most 30 days. Past 30 days the buyer is deemed to have cancelled.
const DENDA_RATE = 0.001, DENDA_MAX_HARI = 30;

// Fee of one row, from its payments (a part payment lowers the base from the day it is made).
function dendaOf(row, today) {
  if (!row.due || !row.jumlah || !isISO(today)) return { denda: 0, hari: 0 };
  const last = Math.min(daysBetween(row.due, today), DENDA_MAX_HARI);
  let denda = 0, hari = 0;
  for (let k = 1; k <= last; k++) {
    const t = addDays(row.due, k);
    const out = row.jumlah - row.kwitansi.reduce((a, p) => a + (!isISO(p.tanggal) || p.tanggal <= t ? p.jumlah : 0), 0);
    if (out <= 0) break;
    denda += out * DENDA_RATE; hari += 1;
  }
  return { denda: Math.round(denda), hari };
}

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
    const f = dendaOf(r, today);
    r.denda = f.denda; r.hariDenda = f.hari;
    r.lewatToleransi = r.hariTelat > DENDA_MAX_HARI;
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
    denda: list.reduce((a, r) => a + r.denda, 0),
    lewatToleransi: list.some((r) => r.lewatToleransi),
    persen: tagihan ? Math.min(100, Math.round((dibayar / tagihan) * 100)) : 0,
    next: next && { key: next.key, label: next.label, due: next.due, sisa: next.sisa },
  };
}

module.exports = { allocate, keyOfReceipt, dendaOf, DENDA_RATE, DENDA_MAX_HARI };
