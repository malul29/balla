const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

const r = Router();
r.use(auth.requireRole('admin')); // money in and out: admins only
const id = (req) => { if (!/^\d+$/.test(req.params.id)) throw new auth.HttpError(404, 'Tidak ditemukan.'); return +req.params.id; };

r.get('/', async (req, res) => res.json(await store.keuangan(req.query.bulan)));
r.post('/kas', async (req, res) => res.json(await store.addKas(req.body || {}, req.user)));
r.delete('/kas/:id', async (req, res) => { await store.deleteKas(id(req), req.user); res.json({ ok: true }); });
r.get('/kontraktor', async (_req, res) => res.json(await store.listKontraktor()));
r.post('/kontraktor', async (req, res) => res.json(await store.saveKontraktor(null, req.body || {}, req.user)));
r.put('/kontraktor/:id', async (req, res) => res.json(await store.saveKontraktor(id(req), req.body || {}, req.user)));
r.get('/spk', async (_req, res) => res.json(await store.listSpk()));
r.post('/spk', async (req, res) => res.json(await store.createSpk(req.body || {}, req.user)));
r.put('/spk/:id', async (req, res) => { await store.setSpkStatus(id(req), req.body || {}, req.user); res.json({ ok: true }); });
r.post('/termin/:id/bayar', async (req, res) => { await store.bayarTermin(id(req), req.body || {}, req.user); res.json({ ok: true }); });
r.post('/termin/:id/batal', async (req, res) => { await store.batalBayarTermin(id(req), req.user); res.json({ ok: true }); });

module.exports = r;
