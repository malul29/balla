const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

const r = Router();
r.use(auth.requireAuth); // warehouse staff record movements; values and master data are for admins
const id = (req) => { if (!/^\d+$/.test(req.params.id)) throw new auth.HttpError(404, 'Tidak ditemukan.'); return +req.params.id; };

r.get('/', async (req, res) => res.json(await store.gudangList(req.user)));
r.get('/riwayat', async (req, res) => res.json(await store.gudangRiwayat(req.query, req.user)));
r.get('/pemakaian', async (req, res) => res.json(await store.gudangPemakaian(req.user)));
r.post('/transaksi', async (req, res) => res.json(await store.gudangTransaksi(req.body || {}, req.user)));
r.post('/riwayat/:id/batalkan', auth.requireRole('admin'), async (req, res) => { await store.gudangBatalkan(id(req), req.user); res.json({ ok: true }); });
r.post('/material', auth.requireRole('admin'), async (req, res) => res.json(await store.createMaterial(req.body || {}, req.user)));
r.put('/material/:id', auth.requireRole('admin'), async (req, res) => res.json(await store.updateMaterial(id(req), req.body || {}, req.user)));
r.post('/lokasi', auth.requireRole('admin'), async (req, res) => res.json(await store.saveGudang(null, req.body || {}, req.user)));
r.put('/lokasi/:id', auth.requireRole('admin'), async (req, res) => res.json(await store.saveGudang(id(req), req.body || {}, req.user)));

module.exports = r;
