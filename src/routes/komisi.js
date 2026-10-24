const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

const r = Router();
r.use(auth.requireRole('admin')); // commission is money: admins only
const id = (req) => { if (!/^\d+$/.test(req.params.id)) throw new auth.HttpError(404, 'Tidak ditemukan.'); return +req.params.id; };

r.get('/', async (_req, res) => res.json(await store.komisi()));
r.post('/sales', async (req, res) => res.json(await store.createSales(req.body || {}, req.user)));
r.put('/sales/:id', async (req, res) => res.json(await store.updateSales(id(req), req.body || {}, req.user)));
r.post('/payout', async (req, res) => res.json(await store.addPayout(req.body || {}, req.user)));
r.delete('/payout/:id', async (req, res) => { await store.deletePayout(id(req), req.user); res.json({ ok: true }); });

module.exports = r;
