const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

const r = Router();
r.use(auth.requireRole('admin')); // money figures: admins only, like the sales report

r.get('/', async (_req, res) => res.json(await store.piutang()));

// Excel-friendly CSV (UTF-8 with BOM, semicolons for Indonesian regional settings), one line per schedule row.
// Text starting with = + - @ is prefixed so a spreadsheet never runs it as a formula.
const STATUS = { lunas: 'Lunas', sebagian: 'Sebagian', belum: 'Belum' };
r.get('/csv', async (_req, res) => {
  const p = await store.piutang();
  const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[";\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const head = ['Unit', 'Pemesan', 'No. SKU/SPU', 'Cara Bayar', 'Keterangan', 'Jatuh Tempo', 'Jumlah (Rp)', 'Dibayar (Rp)', 'Sisa (Rp)', 'Status', 'Hari Telat', 'Denda (Rp)'];
  const lines = [head, ...p.units.flatMap((u) => u.rows.map((r) => [u.unit, u.pemesan, u.surat.no, u.cara, r.label, r.due, r.jumlah, r.dibayar, r.sisa, r.hariTelat ? 'Telat' : STATUS[r.status], r.hariTelat, r.denda]))].map((l) => l.map(cell).join(';'));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="piutang-${p.today}.csv"` });
  res.send('\ufeff' + lines.join('\r\n') + '\r\n');
});

module.exports = r;
