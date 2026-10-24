const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

const r = Router();
r.use(auth.requireRole('admin')); // money figures: admins only, like the sales report

r.get('/', async (_req, res) => res.json(await store.piutang()));

module.exports = r;
