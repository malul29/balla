const { Router, raw } = require('express');
const auth = require('../auth');
const store = require('../store');
const { FILE_KINDS } = require('../../lib/validation');

const MAX = 8 * 1024 * 1024; // 8 MB
const { sniff } = require('../../lib/sniff');
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const cleanName = (n, kind, mime) => {
  const base = String(n || '').replace(/[^\w.\- ]+/g, '_').replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 80).trim() || kind;
  return `${base}.${EXT[mime]}`;
};

const r = Router();
r.use(auth.requireAuth);

// Raw body upload: POST /api/uploads?kind=ktp&name=ktp-budi.jpg   (body = the file)
r.post('/', raw({ type: () => true, limit: MAX }), async (req, res) => {
  const kind = String(req.query.kind || '');
  if (!FILE_KINDS[kind]) throw new auth.HttpError(400, 'Jenis berkas tidak dikenal.');
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length) throw new auth.HttpError(400, 'Berkas kosong.');
  const mime = sniff(data);
  if (!mime) throw new auth.HttpError(415, 'Format berkas harus PDF, JPG, PNG, atau WEBP.');
  res.json(await store.saveUpload({ user: req.user, kind, filename: cleanName(req.query.name, kind, mime), mime, data }));
});

// View (inline, default) or save (?download=1). The body was type-checked from its bytes on upload and is only ever
// served as PDF / JPG / PNG / WEBP with nosniff. No CSP "sandbox" here: it blanks Chrome's built-in PDF viewer.
// The app-wide X-Frame-Options: DENY is relaxed to same-origin so the in-page viewer can embed the file.
r.get('/:id', async (req, res) => {
  const u = await store.getUpload(req.params.id);
  if (!u) throw new auth.HttpError(404, 'Berkas tidak ditemukan.');
  res.set({
    'Content-Type': u.mime,
    'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${u.filename}"`,
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
    'Cache-Control': 'private, no-store',
  });
  res.send(u.data);
});

r.delete('/:id', async (req, res) => {
  await store.deleteUpload(req.params.id, req.user);
  res.json({ ok: true });
});

module.exports = r;
