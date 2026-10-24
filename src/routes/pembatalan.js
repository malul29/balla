const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

const r = Router();
r.use(auth.requireRole('admin')); // cancelling an order moves money: admins only

r.get('/', async (_req, res) => res.json(await store.listCancellations()));
r.get('/preview', async (req, res) => res.json(await store.cancelPreview(String(req.query.no_unit || ''))));
r.post('/', async (req, res) => res.json(await store.cancelOrder(req.body || {}, req.user)));
r.post('/:id/refund', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new auth.HttpError(404, 'Tidak ditemukan.');
  await store.markRefund(+req.params.id, req.body || {}, req.user);
  res.json({ ok: true });
});

module.exports = r;
