const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

const r = Router();
r.use(auth.requireAuth); // the daily file work of every staff member; no money figures here

r.get('/', async (_req, res) => res.json(await store.berkasList()));
r.get('/:unit/riwayat', async (req, res) => res.json(await store.kprEvents(req.params.unit)));
r.put('/:unit/item', async (req, res) => { await store.setBerkasItem(req.params.unit, req.body || {}, req.user); res.json({ ok: true }); });
r.put('/:unit', async (req, res) => { await store.setBerkasInfo(req.params.unit, req.body || {}, req.user); res.json({ ok: true }); });

module.exports = r;
