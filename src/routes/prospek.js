const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

const r = Router();
r.use(auth.requireAuth);
const id = (req) => { if (!/^\d+$/.test(req.params.id)) throw new auth.HttpError(404, 'Tidak ditemukan.'); return +req.params.id; };

// Prospects are the sales team's daily work: every signed-in user. Turning one into an order (commission) is admin only.
r.get('/', async (_req, res) => res.json(await store.listProspects()));
r.get('/sales', async (_req, res) => res.json(await store.listSalesNames()));
r.post('/', async (req, res) => res.json(await store.createProspect(req.body || {}, req.user)));
r.put('/:id', async (req, res) => res.json(await store.updateProspect(id(req), req.body || {}, req.user)));
r.get('/:id/catatan', async (req, res) => res.json(await store.listProspectNotes(id(req))));
r.post('/:id/catatan', async (req, res) => { await store.addProspectNote(id(req), req.body || {}, req.user); res.json({ ok: true }); });
r.post('/:id/konversi', auth.requireRole('admin'), async (req, res) => res.json(await store.convertProspect(id(req), req.body || {}, req.user)));
r.delete('/:id', auth.requireRole('admin'), async (req, res) => { await store.deleteProspect(id(req), req.user); res.json({ ok: true }); });

module.exports = r;
