const { Router, raw } = require('express');
const auth = require('../auth');
const store = require('../store');
const docs = require('../../lib/docs');
const pdf = require('../../lib/pdf');
const P = require('../../lib/progres');
const { sniff } = require('../../lib/sniff');

const MAX = 8 * 1024 * 1024;
const PHOTO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const r = Router();
r.use(auth.requireAuth); // site and handover work: every staff member; money (late fee) only for admins
const num = (req) => { if (!/^\d+$/.test(req.params.id)) throw new auth.HttpError(404, 'Tidak ditemukan.'); return +req.params.id; };

r.get('/', async (req, res) => res.json(await store.progresList(req.user)));

// Site photo: raw body, images only. Served inline, nosniff, never as HTML.
r.get('/foto/:id', async (req, res) => {
  const f = await store.getFoto(req.params.id);
  if (!f) throw new auth.HttpError(404, 'Foto tidak ditemukan.');
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${f.filename}"`, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", 'Cache-Control': 'private, max-age=3600' });
  res.send(f.data);
});
r.delete('/foto/:id', async (req, res) => { await store.deleteFoto(req.params.id, req.user); res.json({ ok: true }); });
r.put('/punch/:id', async (req, res) => { await store.setPunch(num(req), req.body || {}, req.user); res.json({ ok: true }); });
r.delete('/punch/:id', auth.requireRole('admin'), async (req, res) => { await store.deletePunch(num(req), req.user); res.json({ ok: true }); });

r.get('/:unit', async (req, res) => res.json(await store.progresUnit(req.params.unit, req.user)));
r.put('/:unit/tahap', async (req, res) => { await store.setProgres(req.params.unit, req.body || {}, req.user); res.json({ ok: true }); });
r.post('/:unit/foto', raw({ type: () => true, limit: MAX }), async (req, res) => {
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length) throw new auth.HttpError(400, 'Foto kosong.');
  const mime = sniff(data);
  if (!PHOTO[mime]) throw new auth.HttpError(415, 'Foto harus berformat JPG, PNG, atau WEBP.');
  const base = String(req.query.name || '').replace(/[^\w.\- ]+/g, '_').replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 60).trim() || 'foto';
  res.json(await store.addFoto({ no: req.params.unit, kode: String(req.query.kode || ''), keterangan: String(req.query.ket || ''), tanggal: req.query.tanggal, filename: `${base}.${PHOTO[mime]}`, mime, data, user: req.user }));
});
r.post('/:unit/punch', async (req, res) => res.json(await store.addPunch(req.params.unit, req.body || {}, req.user)));

// Late handover fee for a given value of unfinished work (admin: it is money).
r.get('/:unit/denda', auth.requireRole('admin'), async (req, res) => {
  const row = (await store.progresList(req.user)).units.find((u) => u.unit.toLowerCase() === String(req.params.unit).toLowerCase());
  if (!row) throw new auth.HttpError(404, 'Unit tidak ditemukan.');
  const sisa = Math.max(0, Math.round(Number(req.query.sisa) || 0));
  res.json({ hariTelat: row.hariTelat, sisa, denda: P.dendaSerah(sisa, row.hariTelat), maks: Math.round(sisa * 0.03) });
});

r.post('/:unit/serah-terima', async (req, res) => res.json(await store.createHandover(req.params.unit, req.body || {}, req.user)));
r.get('/:unit/bast.pdf', async (req, res) => {
  const out = await pdf.docxToPdf(await docs.bast(await store.bastData(req.params.unit)));
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="BAST_${String(req.params.unit).replace(/[^\w-]/g, '_')}.pdf"`, 'Cache-Control': 'private, no-store' });
  res.send(out);
});

module.exports = r;
