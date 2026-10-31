const { Router } = require('express');
const auth = require('../auth');
const store = require('../store');

// Notifications are derived from the current operational state.  That keeps an
// alert from lingering after its underlying task has been resolved.
const r = Router();
r.use(auth.requireAuth);

r.get('/', async (req, res) => res.json(await store.notifications(req.user)));

module.exports = r;
