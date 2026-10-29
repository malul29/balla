// End-to-end tests against a real PostgreSQL (embedded, throw-away) and the real Express app.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pdf = require('../lib/pdf');

let pg, server, base;
const jar = {};   // username -> cookie

async function call(method, url, { body, as, headers } = {}) {
  const h = { 'X-Requested-With': 'fetch', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) };
  if (as && jar[as]) h.Cookie = jar[as];
  return fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
}
async function login(u, p) {
  const r = await call('POST', '/api/auth/login', { body: { username: u, password: p } });
  if (r.ok) jar[u] = r.headers.get('set-cookie').split(';')[0];
  return r;
}

// ── payload builders: complete, valid documents (everything is required to print) ──
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
async function upload(as, kind, buf = PNG, name = 'scan.png') {
  const r = await fetch(`${base}/api/uploads?kind=${kind}&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/octet-stream', Cookie: jar[as] }, body: buf });
  return r;
}
async function files(as, kinds) {
  const out = {};
  for (const k of kinds) out[k] = (await (await upload(as, k)).json()).id;
  return out;
}
const J = {
  reservasi: { tanggal: '2026-09-30', jumlah: '1000000' },
  booking: { tanggal: '2026-10-02', jumlah: '5000000' },
  pelunasan: { jumlah: '644000000' },
};
const unitDoc = (o = {}) => ({
  tanggal: '2026-09-30', nama: 'Budi', alamatKtp: 'Jl A', alamatSurat: 'Jl B', nikNpwp: '123', telp: '0812', email: 'b@x.co',
  sumber: 'medsos', type: 'Deluxe', noUnit: 'A-01', luasTanah: '71,5', luasBangunan: '129', harga: '650000000', listrik: 'kost',
  cara: { tipe: 'tunai-keras' }, jadwal: J, penerima: 'Ros', sales: 'Sari', ...o,
});
const kwDoc = (o = {}) => ({ tanggal: '2026-09-30', terimaDari: 'Budi', jumlah: 5000000, jenis: 'tunai', untuk: 'booking', noUnit: 'A-01', penandatangan: 'Ros', rekening: 'pt-balla', ...o });
const ttDoc = (o = {}) => ({ tanggal: '2026-09-30', kepada: 'PT Maju', alamat: 'Jl A', up: 'Bpk X', suratNo: '001', kwitansi: '002', dokumen: 'SKU', gambar: '-', keterangan: 'Mohon dikonfirmasi', penerima: 'A', penyerah: 'B', ...o });
const sku = async (as, o = {}) => unitDoc({ files: await files(as, ['ktp', 'npwp']), ...o });
const nextNo = async (as, d = '2026-09-30') => (await (await call('GET', `/api/next-number?tanggal=${d}`, { as })).json()).no;
const units = async (as) => (await call('GET', '/api/units', { as })).json();
const unitOf = async (as, no) => (await units(as)).find((u) => u.no_unit === no);

before(async () => {
  const EmbeddedPostgres = (await import('embedded-postgres')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sultana-pg-'));
  const port = 54400 + Math.floor(Math.random() * 500);
  pg = new EmbeddedPostgres({ databaseDir: dir, user: 't', password: 't', port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise(); await pg.start(); await pg.createDatabase('t');
  process.env.DATABASE_URL = `postgres://t:t@localhost:${port}/t`;
  process.env.ADMIN_USERNAME = 'boss'; process.env.ADMIN_PASSWORD = 'bosspass123';
  const db = require('../src/db'), store = require('../src/store'), config = require('../src/config');
  await db.migrate(); await store.ensureAdmin(config.admin);
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await require('../src/db').close();
  await pg?.stop();
});

test('healthz reports database up', async () => {
  assert.equal((await call('GET', '/healthz')).status, 200);
});

test('app and api need a session; login page is public', async () => {
  assert.equal((await call('GET', '/')).status, 302);
  assert.equal((await call('GET', '/api/units')).status, 401);
  assert.equal((await call('GET', '/login.html')).status, 200);
  assert.equal((await call('GET', '/assets/logo-color.png')).status, 200);
  assert.equal((await call('GET', '/index.html')).status, 302);
});

test('every data endpoint refuses anonymous requests', async () => {
  for (const [m, u] of [['GET', '/api/unit-types'], ['GET', '/api/company'], ['GET', '/api/terms'], ['GET', '/api/next-number'], ['GET', '/api/documents'], ['GET', '/api/documents/1'],
    ['GET', '/api/documents/1/download'], ['PUT', '/api/documents/1'], ['POST', '/api/kwitansi'], ['POST', '/api/tanda-terima'], ['POST', '/api/surat-konfirmasi'], ['POST', '/api/surat-pemesanan'],
    ['GET', '/api/syarat-pesanan.pdf'], ['GET', '/api/kwitansi-kosong.pdf'], ['POST', '/api/uploads?kind=ktp'], ['GET', '/api/uploads/x'], ['GET', '/api/report'], ['GET', '/api/report/csv'], ['GET', '/api/tagihan'], ['GET', '/api/pembatalan'], ['POST', '/api/pembatalan'], ['GET', '/api/tagihan/csv'], ['GET', '/api/prospek'], ['POST', '/api/prospek'], ['GET', '/api/prospek/sales'], ['GET', '/api/komisi'], ['GET', '/api/keuangan'], ['POST', '/api/keuangan/kas'], ['GET', '/api/gudang'], ['POST', '/api/gudang/transaksi'], ['GET', '/api/gudang/pemakaian'], ['GET', '/api/progres'], ['POST', '/api/progres/A-01/serah-terima'], ['GET', '/api/progres/foto/x'], ['GET', '/api/berkas'], ['PUT', '/api/berkas/A-01/item'], ['POST', '/api/komisi/payout'], ['GET', '/api/kwitansi-saran?unit=x'],
    ['GET', '/api/units'], ['GET', '/api/users']]) {
    const r = await call(m, u, m === 'GET' ? {} : { body: {} });
    assert.equal(r.status, 401, `${m} ${u} should need login`);
  }
});

test('wrong password rejected, right one accepted, session cookie is httpOnly', async () => {
  assert.equal((await login('boss', 'nope-nope')).status, 401);
  const r = await login('boss', 'bosspass123');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/i);
  assert.equal((await call('GET', '/', { as: 'boss' })).status, 200);
});

test('writes without the CSRF header are refused', async () => {
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: jar.boss } })).status, 403);
});

test('admin creates a staff user; staff cannot manage users or stock', async () => {
  assert.equal((await call('POST', '/api/users', { as: 'boss', body: { username: 'sales1', name: 'Sales Satu', role: 'staff', password: 'sales-pass-1' } })).status, 200);
  assert.equal((await call('POST', '/api/users', { as: 'boss', body: { username: 'SALES1', name: 'Dup', role: 'staff', password: 'sales-pass-1' } })).status, 409);
  assert.equal((await call('POST', '/api/users', { as: 'boss', body: { username: 'x', name: 'Short', role: 'staff', password: 'sales-pass-1' } })).status, 400);
  assert.equal((await login('sales1', 'sales-pass-1')).status, 200);
  assert.equal((await call('GET', '/api/users', { as: 'sales1' })).status, 403);
  assert.equal((await call('POST', '/api/units', { as: 'sales1', body: { no_unit: 'Z-1' } })).status, 403);
  assert.equal((await call('GET', '/api/units', { as: 'sales1' })).status, 200);
});

test('last admin cannot be demoted or disabled', async () => {
  const boss = (await (await call('GET', '/api/users', { as: 'boss' })).json()).find((u) => u.username === 'boss');
  assert.equal((await call('PATCH', `/api/users/${boss.id}`, { as: 'boss', body: { role: 'staff' } })).status, 400);
});

test('incomplete documents are refused with the list of what is missing, and use no number', async () => {
  const before = await nextNo('boss');
  let r = await call('POST', '/api/surat-konfirmasi', { as: 'boss', body: { nama: 'Budi' } });
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.ok(j.missing.includes('Alamat (sesuai KTP)') && j.missing.includes('Cara Pembayaran'));
  assert.ok(!j.missing.some((m) => m.startsWith('Unggah')), 'uploads are optional');
  assert.match(j.error, /^Lengkapi dulu: /);
  // every kind of document enforces it
  for (const u of ['kwitansi', 'tanda-terima', 'surat-pemesanan']) assert.equal((await call('POST', '/api/' + u, { as: 'boss', body: { tanggal: '2026-09-30' } })).status, 422, u);
  // one empty field is enough
  assert.equal((await call('POST', '/api/kwitansi', { as: 'boss', body: kwDoc({ penandatangan: '  ' }) })).status, 422);
  assert.equal((await call('POST', '/api/tanda-terima', { as: 'boss', body: ttDoc({ gambar: '' }) })).status, 422);
  assert.equal(await nextNo('boss'), before, 'refused documents must not consume a number');
  assert.equal((await (await call('GET', '/api/documents', { as: 'boss' })).json()).total, 0);
});

test('conditional requirements: transfer needs bank + account, DP needs its number, KPR needs a schedule', async () => {
  const miss = async (u, b) => (await (await call('POST', '/api/' + u, { as: 'boss', body: b })).json()).missing || [];
  assert.deepEqual((await miss('kwitansi', kwDoc({ jenis: 'transfer', untuk: 'dp' }))).sort(), ['Bank', 'DP ke-', 'Tanggal transfer']);
  assert.deepEqual(await miss('kwitansi', kwDoc({ jenis: 'tunai', untuk: 'booking' })), [], 'cash booking needs none of them');
  // "cair di rekening" is required for every payment type, cash included
  for (const jenis of ['tunai', 'transfer']) assert.ok((await miss('kwitansi', kwDoc({ jenis, rekening: '', bank: 'BTN', tglTransfer: '2026-09-30', untuk: 'booking' }))).includes('Cair di rekening'), jenis);
  const kpr = unitDoc({ files: await files('boss', ['ktp', 'npwp']), cara: { tipe: 'kpr' }, jadwal: { ...J, kali: 3, mulai: '2026-11-05' } });
  const m = await miss('surat-konfirmasi', kpr);
  assert.ok(m.includes('Jumlah Uang Muka 1/3') && m.includes('Jatuh tempo Pelunasan KPR') && !m.includes('Jatuh tempo Uang Muka 2/3'), 'instalment dates are worked out, amounts are typed');
  assert.ok((await miss('surat-konfirmasi', { ...kpr, jadwal: { ...kpr.jadwal, kali: 13 } })).some((x) => /Jumlah uang muka \(1–12 kali\)/.test(x)));
  const bertahap = unitDoc({ files: await files('boss', ['ktp', 'npwp']), cara: { tipe: 'tunai-bertahap' }, jadwal: { ...J, kali: 11, mulai: '2026-11-05' } });
  assert.ok((await miss('surat-konfirmasi', bertahap)).some((x) => /Jumlah angsuran \(1–10 kali\)/.test(x)));
  // "lain-lain" asks for details
  assert.ok((await miss('surat-konfirmasi', unitDoc({ files: await files('boss', ['ktp', 'npwp']), sumber: 'lain-lain' }))).includes('Sumber Informasi (lain-lain)'));
});

test('uploads: only PDF/JPG/PNG/WEBP by content, owned by the uploader, one use only', async () => {
  const bad = await upload('sales1', 'ktp', Buffer.from('<html>not an image</html>'), 'x.png');
  assert.equal(bad.status, 415);
  assert.equal((await upload('sales1', 'selfie')).status, 400);
  assert.equal((await upload('sales1', 'ktp', Buffer.alloc(0))).status, 400);
  const ok = await upload('sales1', 'ktp', PNG, 'KTP Budi!!.png');
  assert.equal(ok.status, 200);
  const f = await ok.json();
  assert.equal(f.mime, 'image/png'); assert.equal(f.filename, 'KTP Budi_.png'); assert.equal(f.kind, 'ktp');
  const got = await call('GET', `/api/uploads/${f.id}`, { as: 'sales1' });
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png');
  // view: inline, embeddable by this app only (no CSP sandbox, it blanks Chrome's PDF viewer); download: attachment
  assert.match(got.headers.get('content-disposition'), /^inline;/);
  assert.equal(got.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-security-policy'), /default-src 'none'.*frame-ancestors 'self'/);
  assert.doesNotMatch(got.headers.get('content-security-policy'), /sandbox/);
  const dl = await call('GET', `/api/uploads/${f.id}?download=1`, { as: 'sales1' });
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="KTP Budi_\.png"$/);
  assert.equal((await call('GET', `/api/uploads/${f.id}`)).status, 401, 'files need a login');
  assert.equal((await call('DELETE', `/api/uploads/${f.id}`, { as: 'sales1' })).status, 200);
  assert.equal((await call('GET', `/api/uploads/${f.id}`, { as: 'sales1' })).status, 404);
  // someone else's upload cannot be attached to my document
  const theirs = await files('sales1', ['ktp', 'npwp']);
  const r = await call('POST', '/api/surat-konfirmasi', { as: 'boss', body: unitDoc({ files: { ...theirs } }) });
  assert.equal(r.status, 200, 'an admin may attach any pending upload');
});

test('unit flow: SKU marks the unit dipesan, Kwitansi marks it terjual, later receipts still work', async () => {
  assert.deepEqual(await (await call('POST', '/api/units', { as: 'boss', body: { units: [{ no_unit: 'A-01', type: 'Deluxe', harga: 650000000 }, { no_unit: 'A-02', type: 'Executive' }, { no_unit: 'A-03', type: 'Premiere' }] } })).json(), { added: 3, skipped: [] });
  assert.deepEqual(await (await call('POST', '/api/units', { as: 'boss', body: { units: [{ no_unit: 'a-01' }] } })).json(), { added: 0, skipped: ['a-01'] });

  // A-01 was just used by the upload test's SKU (admin attached it) — release it for a clean flow
  const a1 = await unitOf('boss', 'A-01');
  await call('POST', `/api/units/${a1.id}`, { as: 'boss', body: { status: 'tersedia' } });

  const start = Number((await nextNo('boss')).slice(0, 3));
  let r = await call('POST', '/api/surat-konfirmasi', { as: 'sales1', body: await sku('sales1', { noUnit: 'a-01' }) });
  assert.equal(r.status, 200);
  const created = await r.json();
  assert.equal(Number(created.no.slice(0, 3)), start);
  assert.match(created.no, /^\d{3}\/SL-BSS\/IX\/2026$/);
  assert.equal(created.file, `SKU_${created.no.replace(/[^\w-]+/g, '_')}_Budi.pdf`);
  assert.equal(created.pdf, `/api/documents/${created.id}/pdf`);
  if (pdf.available()) {
    assert.equal(created.pdfReady, true);
    const p = await call('GET', created.pdf, { as: 'sales1' });
    assert.equal(p.headers.get('content-type'), 'application/pdf');
    assert.match(p.headers.get('content-disposition'), /^inline; filename="SKU_/);
    assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.match((await call('GET', created.pdf + '?download=1', { as: 'sales1' })).headers.get('content-disposition'), /^attachment;/);
  }
  const held = await unitOf('boss', 'A-01');
  assert.equal(held.status, 'dipesan'); assert.equal(held.pemesan, 'Budi'); assert.equal(held.doc_no, created.no);
  assert.equal((await call('POST', '/api/surat-pemesanan', { as: 'boss', body: await sku('boss', { noUnit: 'A-01', nama: 'Ani' }) })).status, 200, 'a merely reserved unit can still be re-booked');

  // while reserved, the unit list carries the value and the latest buyer from its SKU/SPU
  const listed = await unitOf('boss', 'A-01');
  assert.equal(listed.nilai, 650000000); assert.equal(listed.pemesan_terakhir, 'Ani'); assert.ok(listed.booking_no.endsWith('/SL-BSS/IX/2026'));
  assert.equal((await unitOf('boss', 'A-03')).nilai, null, 'a unit nobody holds has no value');
  assert.equal((await unitOf('boss', 'A-03')).pemesan_terakhir, null);

  // a receipt marks it sold…
  r = await call('POST', '/api/kwitansi', { as: 'sales1', body: kwDoc() });
  assert.equal(r.status, 200);
  const sold = await unitOf('boss', 'A-01'); assert.equal(sold.status, 'terjual');
  // …and further receipts (DP instalments) are still accepted, without changing who owns the unit
  const soldInfo = await unitOf('boss', 'A-01');
  assert.equal(soldInfo.nilai, 650000000); assert.equal(soldInfo.pemesan_terakhir, 'Ani', 'sold: still the latest SKU/SPU name');
  const owner = sold.pemesan;
  assert.equal((await call('POST', '/api/kwitansi', { as: 'sales1', body: kwDoc({ untuk: 'dp', dpKe: '1', jumlah: 2000000 }) })).status, 200);
  const still = await unitOf('boss', 'A-01'); assert.equal(still.status, 'terjual'); assert.equal(still.pemesan, owner); assert.equal(still.doc_no, sold.doc_no);

  // a sold unit cannot be booked again, and the refusal costs no number
  const n = await nextNo('boss');
  r = await call('POST', '/api/surat-pemesanan', { as: 'boss', body: await sku('boss', { noUnit: 'A-01', nama: 'Cici' }) });
  assert.equal(r.status, 409); assert.match((await r.json()).error, /sudah berstatus "terjual"/);
  assert.equal(await nextNo('boss'), n);

  await call('POST', `/api/units/${a1.id}`, { as: 'boss', body: { status: 'tersedia' } });
  const free = await unitOf('boss', 'A-01'); assert.equal(free.status, 'tersedia'); assert.equal(free.pemesan, '');
  assert.equal((await call('POST', `/api/units/${a1.id}`, { as: 'boss', body: { status: 'lunas' } })).status, 400);
});

test('uploads are optional: a document prints without them, and with them they are attached', async () => {
  const none = await call('POST', '/api/surat-pemesanan', { as: 'boss', body: unitDoc({ noUnit: 'A-02', type: 'Executive' }) });
  assert.equal(none.status, 200, 'no KTP/NPWP needed');
  const a2 = await unitOf('boss', 'A-02'); await call('POST', `/api/units/${a2.id}`, { as: 'boss', body: { status: 'tersedia' } });
  const kprDoc = { noUnit: 'A-02', type: 'Executive', cara: { tipe: 'kpr' }, jadwal: { booking: J.booking, kali: 2, mulai: '2026-11-05', cicilan: [{ jumlah: '1000000' }, { jumlah: '1000000' }], pelunasan: { tanggal: '2027-12-01', jumlah: '600000000' } } };
  const some = await call('POST', '/api/surat-pemesanan', { as: 'boss', body: unitDoc({ ...kprDoc, files: await files('boss', ['ktp']) }) });
  assert.equal(some.status, 200, 'KPR with only some of the files');
  const got = await (await call('GET', `/api/documents/${(await some.json()).id}`, { as: 'boss' })).json();
  assert.deepEqual(got.files.map((f) => f.kind), ['ktp']);
  const a2b = await unitOf('boss', 'A-02'); await call('POST', `/api/units/${a2b.id}`, { as: 'boss', body: { status: 'tersedia' } });
  // a file that is not valid is still refused when it is given
  const bogus = await call('POST', '/api/surat-pemesanan', { as: 'boss', body: unitDoc({ noUnit: 'A-02', type: 'Executive', files: { ktp: '00000000-0000-0000-0000-000000000000' } }) });
  assert.equal(bogus.status, 422);
});

test('admin edits unit details in any status; staff cannot', async () => {
  const a3 = await unitOf('boss', 'A-03');
  let r = await call('POST', `/api/units/${a3.id}`, { as: 'boss', body: { type: 'Deluxe', harga: 900000000 } });
  assert.equal(r.status, 200);
  const after = await unitOf('boss', 'A-03'); assert.equal(after.type, 'Deluxe'); assert.equal(after.harga, 900000000);
  assert.equal((await call('POST', `/api/units/${a3.id}`, { as: 'boss', body: { no_unit: 'a-01' } })).status, 409);
  assert.equal((await call('POST', `/api/units/${a3.id}`, { as: 'boss', body: { no_unit: 'A-03B' } })).status, 200);
  assert.equal((await call('POST', `/api/units/${a3.id}`, { as: 'sales1', body: { harga: 1 } })).status, 403);
});

test('only the admin can correct a printed document; number stays, unit stock follows', async () => {
  await call('POST', '/api/units', { as: 'boss', body: { units: [{ no_unit: 'B-01', type: 'Deluxe' }, { no_unit: 'B-02', type: 'Executive' }] } });
  const made = await (await call('POST', '/api/surat-konfirmasi', { as: 'sales1', body: await sku('sales1', { noUnit: 'B-01', nama: 'Dedi' }) })).json();
  const open = await (await call('GET', `/api/documents/${made.id}`, { as: 'sales1' })).json();
  assert.equal(open.data.nama, 'Dedi'); assert.equal(open.files.length, 2);
  const fixed = { ...open.data, nama: 'Dedi Kurniawan', noUnit: 'B-02', type: 'Executive' };

  assert.equal((await call('PUT', `/api/documents/${made.id}`, { as: 'sales1', body: fixed })).status, 403, 'staff may not edit');
  assert.equal((await call('PUT', `/api/documents/${made.id}`, { as: 'boss', body: { ...fixed, alamatKtp: '' } })).status, 422, 'a corrected document must still be complete');

  const r = await call('PUT', `/api/documents/${made.id}`, { as: 'boss', body: fixed });
  assert.equal(r.status, 200);
  const done = await r.json();
  assert.equal(done.no, made.no, 'number never changes');
  const after = await (await call('GET', `/api/documents/${made.id}`, { as: 'boss' })).json();
  assert.equal(after.data.nama, 'Dedi Kurniawan'); assert.equal(after.no, made.no); assert.equal(after.files.length, 2);
  assert.equal((await unitOf('boss', 'B-01')).status, 'tersedia', 'the unit it no longer names is freed');
  const b2 = await unitOf('boss', 'B-02');
  assert.equal(b2.status, 'dipesan'); assert.equal(b2.pemesan, 'Dedi Kurniawan'); assert.equal(b2.doc_no, made.no);
  if (pdf.available()) {
    const p = await call('GET', done.pdf, { as: 'boss' });
    assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  }
  // moving onto a unit someone else holds is refused
  await call('POST', '/api/surat-konfirmasi', { as: 'boss', body: await sku('boss', { noUnit: 'B-01', nama: 'Eka' }) });
  assert.equal((await call('PUT', `/api/documents/${made.id}`, { as: 'boss', body: { ...fixed, noUnit: 'B-01' } })).status, 200, 'a reserved (dipesan) unit may be taken over');
  const b1 = await unitOf('boss', 'B-01'); await call('POST', `/api/units/${b1.id}`, { as: 'boss', body: { status: 'terjual' } });
  assert.equal((await call('PUT', `/api/documents/${made.id}`, { as: 'boss', body: { ...fixed, noUnit: 'B-01' } })).status, 200, 'it already holds B-01');
  const b2again = await unitOf('boss', 'B-02'); await call('POST', `/api/units/${b2again.id}`, { as: 'boss', body: { status: 'terjual' } });
  assert.equal((await call('PUT', `/api/documents/${made.id}`, { as: 'boss', body: { ...fixed, noUnit: 'B-02' } })).status, 409, 'a sold unit cannot be taken over');
  const list = (await (await call('GET', '/api/documents?q=Dedi', { as: 'boss' })).json()).rows;
  assert.equal(list[0].edited, true);
});

test('sales report: a unit sold by receipt only is listed (no price) so units match the stock figures', async () => {
  const before = await (await call('GET', '/api/report', { as: 'boss' })).json();
  assert.equal((await call('POST', '/api/units', { as: 'boss', body: { units: [{ no_unit: 'KW-ONLY', type: 'Deluxe' }] } })).status, 200);
  const made = await call('POST', '/api/kwitansi', { as: 'boss', body: kwDoc({ noUnit: 'KW-ONLY', terimaDari: 'Pembeli Lama', jumlah: 3000000 }) });
  assert.equal(made.status, 200);
  const after = await (await call('GET', '/api/report', { as: 'boss' })).json();
  const row = after.rows.find((r) => r.unit === 'KW-ONLY');
  assert.ok(row, 'listed although there is no SKU/SPU');
  assert.equal(row.tanpaSurat, true); assert.equal(row.harga, 0); assert.equal(row.status, 'terjual'); assert.equal(row.nama, 'Pembeli Lama');
  // the stock card forgets the buyer (a manual status change clears it): the unit's own receipt still names them
  const card = (await (await call('GET', '/api/units', { as: 'boss' })).json()).find((u) => u.no_unit === 'KW-ONLY');
  await call('POST', `/api/units/${card.id}`, { as: 'boss', body: { status: 'dipesan' } });
  await call('POST', `/api/units/${card.id}`, { as: 'boss', body: { status: 'terjual' } });
  const again = (await (await call('GET', '/api/report', { as: 'boss' })).json()).rows.find((r) => r.unit === 'KW-ONLY');
  assert.equal(again.nama, 'Pembeli Lama'); assert.equal(again.no, made.headers && (await made.clone().json()).no);
  assert.equal(after.sales.jumlah, before.sales.jumlah + 1, 'it counts as a unit');
  assert.equal(after.sales.nilai, before.sales.nilai, 'but adds no value');
  assert.equal(after.sales.tanpaSurat, before.sales.tanpaSurat + 1);
  assert.equal(after.sales.dihargai, before.sales.dihargai, 'the average only uses priced units');
  assert.equal(after.sales.terjual.jumlah + after.sales.dipesan.jumlah, after.sales.jumlah);
  const csv = (await (await call('GET', '/api/report/csv', { as: 'boss' })).text()).split('\n').find((l) => l.includes('KW-ONLY'));
  assert.match(csv, /;KW-ONLY;Deluxe;;Tanpa SKU\/SPU;/, 'price cell left empty in the CSV');
});

test('sales report: only units still reserved/sold count, by type, payment method, month and sales', async () => {
  assert.equal((await call('GET', '/api/report', { as: 'sales1' })).status, 403, 'the report is for admins only');
  assert.equal((await call('GET', '/api/report/csv', { as: 'sales1' })).status, 403, 'and so is its CSV');
  const rep = await (await call('GET', '/api/report', { as: 'boss' })).json();
  if (process.env.DEBUG_REPORT) console.log(JSON.stringify(rep, null, 1));
  assert.equal(rep.stock.total, rep.stock.tersedia + rep.stock.dipesan + rep.stock.terjual);
  assert.equal(rep.sales.jumlah, rep.rows.length);
  assert.equal(rep.sales.nilai, rep.rows.reduce((a, r) => a + r.harga, 0));
  assert.equal(rep.sales.jumlah, rep.sales.terjual.jumlah + rep.sales.dipesan.jumlah);
  assert.ok(rep.sales.byType.length && rep.sales.byCara.some((c) => c.key === 'Tunai Keras') && rep.sales.byMonth.some((m) => m.key === '2026-09') && rep.sales.bySales.some((s) => s.key === 'Sari'));
  assert.ok(rep.rows.every((r) => r.unit && r.no && (r.tanpaSurat ? r.harga === 0 : r.harga > 0)));
  assert.equal(new Set(rep.rows.map((r) => r.unit.toLowerCase())).size, rep.rows.length, 'one row per unit');
  assert.ok(rep.receipts.jumlah >= 2 && rep.receipts.total >= 7000000);
  const none = await (await call('GET', '/api/report?from=2030-01-01&to=2030-12-31', { as: 'boss' })).json();
  assert.equal(none.sales.jumlah, 0); assert.equal(none.receipts.jumlah, 0);
  assert.equal(none.stock.total, rep.stock.total, 'stock is a current snapshot, not period-bound');
  const csv = await call('GET', '/api/report/csv', { as: 'boss' });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel reads accents correctly');
  const text = bytes.toString('utf8').replace(/^\ufeff/, '');
  assert.ok(text.startsWith('Tanggal;No. Dokumen;Pemesan;Unit;Type;Harga (Rp);Cara Bayar;Sales;Status Unit'));
  assert.equal(text.trim().split('\r\n').length, rep.rows.length + 1);
});

test('fixed terms document comes as a printable PDF', { skip: !pdf.available() && 'LibreOffice not installed' }, async () => {
  const r = await call('GET', '/api/syarat-pesanan.pdf', { as: 'boss' });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('blank receipt: a printable PDF, no number used, nothing stored', async () => {
  const before = await nextNo('boss'), n = (await (await call('GET', '/api/documents', { as: 'boss' })).json()).total;
  const r = await call('GET', '/api/kwitansi-kosong.pdf', { as: 'sales1' });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /^inline;/);
  assert.equal((await r.arrayBuffer()).byteLength > 1000, true);
  assert.match((await call('GET', '/api/kwitansi-kosong.pdf?download=1', { as: 'sales1' })).headers.get('content-disposition'), /^attachment; filename="Kwitansi_Kosong\.pdf"/);
  assert.equal(await nextNo('boss'), before, 'no document number is consumed');
  assert.equal((await (await call('GET', '/api/documents', { as: 'boss' })).json()).total, n, 'nothing is stored');
});

test('numbers are unique and gap-free under concurrent requests', async () => {
  const start = Number((await nextNo('boss', '2026-10-05')).slice(0, 3));
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/api/kwitansi', { as: i % 2 ? 'boss' : 'sales1', body: kwDoc({ terimaDari: 'T' + i, tanggal: '2026-10-05', noUnit: 'ZZ-' + i }) })));
  assert.ok(rs.every((r) => r.status === 200));
  const nums = (await Promise.all(rs.map((r) => r.json()))).map((j) => j.no).sort();
  assert.equal(new Set(nums).size, 12);
  assert.deepEqual(nums.map((n) => Number(n.slice(0, 3))).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => start + i));
  assert.match(nums[0], /\/SL-BSS\/X\/2026$/);
});

test('numbering restarts at 001 every month, and continues a month that already has older numbers', async () => {
  const mk = async (tanggal) => (await (await call('POST', '/api/tanda-terima', { as: 'boss', body: ttDoc({ tanggal }) })).json()).no;
  assert.equal(await nextNo('boss', '2027-03-02'), '001/SL-BSS/III/2027');
  assert.equal(await mk('2027-03-02'), '001/SL-BSS/III/2027');
  assert.equal(await mk('2027-03-20'), '002/SL-BSS/III/2027');
  assert.equal(await mk('2027-04-01'), '001/SL-BSS/IV/2027', 'a new month starts again at 001');
  assert.equal(await mk('2027-03-28'), '003/SL-BSS/III/2027', 'an earlier month keeps its own sequence');
  assert.equal(await nextNo('boss', '2027-03-30'), '004/SL-BSS/III/2027');
  // a month numbered under the old single counter: carry on after its highest number
  const db = require('../src/db');
  await db.query("INSERT INTO documents (no, jenis, nama, data) VALUES ('004/SL-BSS/V/2027', 'tanda-terima', 'lama', '{}')");
  assert.equal(await nextNo('boss', '2027-05-10'), '005/SL-BSS/V/2027');
  assert.equal(await mk('2027-05-10'), '005/SL-BSS/V/2027');
});

test('document history is paged: stable newest-first pages, clamped page, fixed page sizes, filters apply to the count', async () => {
  const get = async (qs) => (await call('GET', '/api/documents' + qs, { as: 'boss' })).json();
  const all = await get('?per=100');
  assert.equal(all.rows.length, Math.min(100, all.total));
  assert.ok(all.total >= 12, 'earlier tests left enough documents');
  const p1 = await get('?per=10&page=1'), p2 = await get('?per=10&page=2');
  assert.equal(p1.per, 10); assert.equal(p1.rows.length, 10); assert.equal(p1.pages, Math.ceil(all.total / 10));
  assert.deepEqual(p1.rows.map((r) => r.id), all.rows.slice(0, 10).map((r) => r.id), 'page 1 = the newest ten');
  assert.deepEqual(p2.rows.map((r) => r.id), all.rows.slice(10, 20).map((r) => r.id), 'page 2 continues without overlap');
  const past = await get('?per=10&page=9999');
  assert.equal(past.page, past.pages, 'a page past the end gives the last page'); assert.ok(past.rows.length > 0);
  assert.equal((await get('?page=abc')).page, 1);
  assert.equal((await get('?per=7')).per, 25, 'unknown page sizes fall back to the default');
  const one = await get('?q=Budi&jenis=surat-konfirmasi&per=10');
  assert.ok(one.total >= 1 && one.total < all.total, 'the count follows the filter');
});

test('receivables: receipts are matched to the SKU schedule; late, part-paid and paid rows; admin only', async () => {
  assert.equal((await call('GET', '/api/tagihan', { as: 'sales1' })).status, 403, 'money figures are for admins only');
  assert.equal((await call('POST', '/api/units', { as: 'boss', body: { units: [{ no_unit: 'PT-1', type: 'Deluxe' }] } })).status, 200);
  const jadwal = { reservasi: { tanggal: '2020-01-01', jumlah: '1000000' }, booking: { tanggal: '2020-01-02', jumlah: '5000000' }, kali: 2, mulai: '2099-01-05', cicilan: [{ jumlah: '10000000' }, { jumlah: '10000000' }] };
  const made = await call('POST', '/api/surat-konfirmasi', { as: 'boss', body: await sku('boss', { noUnit: 'PT-1', nama: 'Pembeli PT', cara: { tipe: 'tunai-bertahap' }, jadwal }) });
  assert.equal(made.status, 200);
  const find = async () => (await (await call('GET', '/api/tagihan', { as: 'boss' })).json()).units.find((u) => u.unit === 'PT-1');

  let u = await find();
  assert.equal(u.pemesan, 'Pembeli PT'); assert.equal(u.tagihan, 26000000); assert.equal(u.dibayar, 0); assert.equal(u.sisa, 26000000);
  assert.equal(u.telat, 6000000, 'reservasi and booking fee are long overdue'); assert.ok(u.hariTelat > 1000);
  assert.deepEqual(u.rows.map((r) => r.key), ['reservasi', 'booking', 'cicilan1', 'cicilan2']);

  const kw = (o) => call('POST', '/api/kwitansi', { as: 'boss', body: kwDoc({ noUnit: 'PT-1', terimaDari: 'Pembeli PT', ...o }) });
  assert.equal((await kw({ untuk: 'reservasi', jumlah: 1000000 })).status, 200);
  assert.equal((await kw({ untuk: 'booking', jumlah: 2000000 })).status, 200);
  assert.equal((await kw({ untuk: 'dp', dpKe: '1', jumlah: 10000000 })).status, 200);
  u = await find();
  assert.deepEqual(u.rows.map((r) => r.status), ['lunas', 'sebagian', 'lunas', 'belum']);
  assert.equal(u.dibayar, 13000000); assert.equal(u.sisa, 13000000); assert.equal(u.persen, 50);
  assert.equal(u.telat, 3000000, 'only what is left of the booking fee is late'); assert.ok(u.rows[1].kwitansi.length === 1);
  assert.equal(u.next.key, 'booking');

  assert.equal((await kw({ untuk: 'booking', jumlah: 3000000 })).status, 200);
  u = await find();
  assert.equal(u.rows[1].status, 'lunas'); assert.equal(u.telat, 0); assert.equal(u.hariTelat, 0);
  assert.equal(u.next.key, 'cicilan2'); assert.equal(u.next.due, '2099-02-05');
  const all = await (await call('GET', '/api/tagihan', { as: 'boss' })).json();
  assert.equal(all.totals.tagihan, all.units.reduce((a, x) => a + x.tagihan, 0));
  assert.equal(all.totals.sisa, all.units.reduce((a, x) => a + x.sisa, 0));
  assert.match(all.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('cancelling an order: suggested split, unit freed, cycle closed, refund tracked, admin only', async () => {
  const boss = (m, u, body) => call(m, u, { as: 'boss', body });
  assert.equal((await boss('POST', '/api/units', { units: [{ no_unit: 'PT-2', type: 'Executive' }] })).status, 200);
  const jadwal = { booking: { tanggal: '2099-01-02', jumlah: '5000000' }, kali: 2, mulai: '2099-02-05', cicilan: [{ jumlah: '10000000' }, { jumlah: '10000000' }], pelunasan: { tanggal: '2099-06-01', jumlah: '100000000' } };
  assert.equal((await boss('POST', '/api/surat-pemesanan', await sku('boss', { noUnit: 'PT-2', type: 'Executive', nama: 'Calon Batal', cara: { tipe: 'kpr' }, jadwal }))).status, 200);
  const kw = (o) => boss('POST', '/api/kwitansi', kwDoc({ noUnit: 'PT-2', terimaDari: 'Calon Batal', ...o }));
  assert.equal((await kw({ untuk: 'booking', jumlah: 5000000 })).status, 200);
  assert.equal((await kw({ untuk: 'dp', dpKe: '1', jumlah: 10000000 })).status, 200);

  for (const as of ['sales1']) for (const [m, u] of [['GET', '/api/pembatalan'], ['GET', '/api/pembatalan/preview?no_unit=PT-2'], ['POST', '/api/pembatalan']]) assert.equal((await call(m, u, { as })).status, 403, m + ' ' + u);

  const pv = await (await call('GET', '/api/pembatalan/preview?no_unit=pt-2', { as: 'boss' })).json();
  assert.equal(pv.dibayar, 15000000); assert.equal(pv.parts.booking, 5000000); assert.equal(pv.parts.uangMuka, 10000000);
  assert.deepEqual(pv.saran, { pembeli: 10000000, wanprestasi: 10000000, bank: 5000000, lainnya: 0 }, 'buyer: booking + 50% of down payments; bank: booking only');
  assert.equal(pv.pemesan, 'Calon Batal');

  assert.equal((await boss('POST', '/api/pembatalan', { no_unit: 'PT-2', alasan: 'hadiah' })).status, 422);
  assert.equal((await boss('POST', '/api/pembatalan', { no_unit: 'PT-2', alasan: 'pembeli', hangus: 99999999 })).status, 422, 'cannot keep more than was paid');
  assert.equal((await boss('POST', '/api/pembatalan', { no_unit: 'NOPE', alasan: 'pembeli' })).status, 404);

  const done = await (await boss('POST', '/api/pembatalan', { no_unit: 'PT-2', alasan: 'bank', catatan: 'KPR ditolak', tanggal: '2026-10-20' })).json();
  assert.deepEqual([done.dibayar, done.hangus, done.kembali], [15000000, 5000000, 10000000]);
  assert.equal((await unitOf('boss', 'PT-2')).status, 'tersedia');
  assert.equal((await boss('POST', '/api/pembatalan', { no_unit: 'PT-2', alasan: 'bank' })).status, 409, 'a free unit cannot be cancelled again');

  const pt = await (await call('GET', '/api/tagihan', { as: 'boss' })).json();
  assert.ok(!pt.units.some((u) => u.unit === 'PT-2'), 'a cancelled order is no longer receivable');
  const rep = await (await call('GET', '/api/report', { as: 'boss' })).json();
  assert.ok(!rep.rows.some((r) => r.unit === 'PT-2'), 'nor a sale');

  const list = await (await call('GET', '/api/pembatalan', { as: 'boss' })).json();
  const row = list.find((r) => r.no_unit === 'PT-2');
  assert.equal(row.alasan, 'bank'); assert.equal(row.catatan, 'KPR ditolak'); assert.equal(row.pengembalian, 'menunggu'); assert.equal(row.tanggal, '2026-10-20'); assert.equal(row.kembali, 10000000);
  assert.equal((await boss('POST', `/api/pembatalan/${row.id}/refund`, { tanggal: '2026-10-25' })).status, 200);
  assert.equal((await boss('POST', `/api/pembatalan/${row.id}/refund`, {})).status, 409, 'already refunded');
  const after = (await (await call('GET', '/api/pembatalan', { as: 'boss' })).json()).find((r) => r.id === row.id);
  assert.equal(after.pengembalian, 'selesai'); assert.equal(after.pengembalian_tanggal, '2026-10-25');

  // the unit can be ordered again, and the old buyer's receipts do not count for the new one
  assert.equal((await boss('POST', '/api/surat-pemesanan', await sku('boss', { noUnit: 'PT-2', type: 'Executive', nama: 'Pembeli Baru', cara: { tipe: 'kpr' }, jadwal }))).status, 200);
  const fresh = (await (await call('GET', '/api/tagihan', { as: 'boss' })).json()).units.find((u) => u.unit === 'PT-2');
  assert.equal(fresh.pemesan, 'Pembeli Baru'); assert.equal(fresh.dibayar, 0, 'a fresh cycle'); assert.equal(fresh.tagihan, 125000000);
  assert.equal((await boss('POST', '/api/pembatalan', { no_unit: 'PT-2', alasan: 'lainnya' })).status, 200, 'with nothing paid there is nothing to refund');
  const none = (await (await call('GET', '/api/pembatalan', { as: 'boss' })).json()).find((r) => r.no_unit === 'PT-2' && r.alasan === 'lainnya');
  assert.equal(none.pengembalian, 'tidak-ada'); assert.equal(none.dibayar, 0);
});

test('receivables CSV (admin, formula-safe) and the schedule suggestion for the receipt form (any user)', async () => {
  assert.equal((await call('GET', '/api/tagihan/csv', { as: 'sales1' })).status, 403);
  assert.equal((await call('POST', '/api/units', { as: 'boss', body: { units: [{ no_unit: 'PT-3', type: 'Deluxe' }] } })).status, 200);
  const jadwal = { booking: { tanggal: '2099-01-02', jumlah: '5000000' }, pelunasan: { tanggal: '2099-02-02', jumlah: '95000000' } };
  assert.equal((await call('POST', '/api/surat-pemesanan', { as: 'boss', body: await sku('boss', { noUnit: 'PT-3', nama: '=HYPERLINK("http://x")', cara: { tipe: 'tunai-keras' }, jadwal }) })).status, 200);

  const res = await call('GET', '/api/tagihan/csv', { as: 'boss' });
  assert.match(res.headers.get('content-type'), /text\/csv/); assert.match(res.headers.get('content-disposition'), /attachment; filename="tagihan-\d{4}-\d{2}-\d{2}\.csv"/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const lines = bytes.toString('utf8').replace(/^\ufeff/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Unit;Pemesan;No. SKU/SPU;Cara Bayar;Keterangan;Jatuh Tempo;Jumlah (Rp);Dibayar (Rp);Sisa (Rp);Status;Hari Telat;Denda (Rp)');
  const pt = await (await call('GET', '/api/tagihan', { as: 'boss' })).json();
  assert.equal(lines.length - 1, pt.units.reduce((a, u) => a + u.rows.length, 0), 'one line per schedule row');
  const evil = lines.find((l) => l.startsWith('PT-3;'));
  assert.ok(evil.includes(`;"'=HYPERLINK(""http://x"")";`), 'a name that looks like a formula is neutralised: ' + evil);
  assert.ok(lines.some((l) => l.startsWith('PT-1;Pembeli PT;') && l.includes(';Booking Fee;') && l.includes(';Lunas;')));

  const sug = await (await call('GET', '/api/kwitansi-saran?unit=pt-1', { as: 'sales1' })).json();
  assert.equal(sug.unit.unit, 'PT-1'); assert.equal(sug.unit.pemesan, 'Pembeli PT');
  assert.deepEqual(sug.unit.rows.map((r) => [r.key, r.sisa]), [['cicilan2', 10000000]], 'only what is still open');
  assert.deepEqual(await (await call('GET', '/api/kwitansi-saran?unit=NOPE', { as: 'sales1' })).json(), { unit: null });
  assert.deepEqual(await (await call('GET', '/api/kwitansi-saran', { as: 'sales1' })).json(), { unit: null });
});

test('a receipt can be for reservasi or pelunasan too', async () => {
  const ok = async (untuk) => (await call('POST', '/api/kwitansi', { as: 'boss', body: kwDoc({ untuk, noUnit: 'ZZ-' + untuk, tanggal: '2026-09-30' }) })).status;
  assert.equal(await ok('reservasi'), 200); assert.equal(await ok('pelunasan'), 200);
  const bad = await call('POST', '/api/kwitansi', { as: 'boss', body: kwDoc({ untuk: 'hadiah', noUnit: 'ZZ-x' }) });
  assert.equal(bad.status, 422); assert.deepEqual((await bad.json()).missing, ['Untuk Pembayaran']);
});

test('history lists documents with author and files; re-download keeps the number', async () => {
  const list = (await (await call('GET', '/api/documents?q=Budi&jenis=surat-konfirmasi', { as: 'boss' })).json()).rows;
  assert.ok(list.length >= 1);
  const row = list.find((d) => d.created_by === 'Sales Satu');
  assert.ok(row && row.files.map((f) => f.kind).sort().join() === 'ktp,npwp');
  const r = await call('GET', `/api/documents/${row.id}/download`, { as: 'boss' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), new RegExp(`SKU_${row.no.replace(/[^\w-]+/g, '_')}_Budi\\.docx`));
  assert.equal((await call('GET', '/api/documents/999999/download', { as: 'boss' })).status, 404);
});

test('disabling a user ends their session; password reset forces re-login', async () => {
  const s1 = (await (await call('GET', '/api/users', { as: 'boss' })).json()).find((u) => u.username === 'sales1');
  assert.equal((await call('GET', '/api/auth/me', { as: 'sales1' })).status, 200);
  assert.equal((await call('PATCH', `/api/users/${s1.id}`, { as: 'boss', body: { active: false } })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { as: 'sales1' })).status, 401);
  const off = await login('sales1', 'sales-pass-1');
  assert.equal(off.status, 403, 'right password but deactivated: say so instead of "wrong password"');
  assert.match((await off.json()).error, /dinonaktifkan/);
  assert.equal((await login('sales1', 'wrong-password-x')).status, 401, 'a wrong password reveals nothing about the account');
  await call('PATCH', `/api/users/${s1.id}`, { as: 'boss', body: { active: true, password: 'brand-new-pass' } });
  assert.equal((await login('sales1', 'brand-new-pass')).status, 200);
});

test('login is locked after repeated failures', async () => {
  for (let i = 0; i < 5; i++) await login('ghost', 'bad-password');
  assert.equal((await login('ghost', 'bad-password')).status, 429);
});

test('the activity list shows at most the latest 100 entries, newest first', async () => {
  const db = require('../src/db');
  await db.query("INSERT INTO audit_log (action, entity, detail) SELECT 'login', 'flood-test', '{}'::jsonb FROM generate_series(1, 130)");
  const rows = await (await call('GET', '/api/users/audit/log', { as: 'boss' })).json();
  assert.equal(rows.length, 100);
  assert.ok(rows.every((r, i) => i === 0 || r.id < rows[i - 1].id), 'newest first');
  assert.equal((await call('GET', '/api/users/audit/log', { as: 'sales1' })).status, 403, 'admins only');
  await db.query("DELETE FROM audit_log WHERE entity = 'flood-test'"); // leave the log as it was for the other tests
});

test('audit trail records the work', async () => {
  const actions = new Set((await (await call('GET', '/api/users/audit/log', { as: 'boss' })).json()).map((a) => a.action));
  for (const a of ['login', 'login.fail', 'document.create', 'document.edit', 'unit.reserve', 'unit.sold', 'unit.status', 'user.create']) assert.ok(actions.has(a), a);
});

test('prospects: staff work the pipeline, admin converts to an order and commission follows the money received', async () => {
  const boss = (m, u, body) => call(m, u, { as: 'boss', body }), staff = (m, u, body) => call(m, u, { as: 'sales1', body });
  assert.equal((await staff('GET', '/api/komisi')).status, 403, 'commission is for admins only');
  assert.equal((await staff('POST', '/api/komisi/sales', { nama: 'X' })).status, 403);

  const mk = await boss('POST', '/api/komisi/sales', { nama: 'Sari', tipe: 'freelance', rate: '2,5' });
  assert.equal(mk.status, 200); const salesId = (await mk.json()).id;
  assert.equal((await boss('POST', '/api/komisi/sales', { nama: 'sari' })).status, 409, 'same name twice');
  assert.equal((await boss('POST', '/api/komisi/sales', { nama: 'Z', rate: 120 })).status, 422);
  assert.deepEqual((await (await staff('GET', '/api/prospek/sales')).json()).map((x) => x.nama), ['Sari'], 'staff see names only');

  assert.equal((await staff('POST', '/api/prospek', { nama: '' })).status, 422);
  assert.equal((await staff('POST', '/api/prospek', { nama: 'Dewi', tahap: 'deal' })).status, 422, 'deal only by linking a unit');
  const pid = (await (await staff('POST', '/api/prospek', { nama: 'Dewi', telp: '0812345678901', sumber: 'instagram', sales_id: salesId, follow_up: '2020-01-01' })).json()).id;
  let list = await (await staff('GET', '/api/prospek')).json();
  assert.equal(list.prospects.find((p) => p.id === pid).tahap, 'baru');
  assert.equal(list.stats.terlambat, 1, 'follow-up date in the past is overdue');

  assert.equal((await staff('POST', `/api/prospek/${pid}/catatan`, { isi: '' })).status, 422);
  assert.equal((await staff('POST', `/api/prospek/${pid}/catatan`, { jenis: 'telepon', isi: 'Tertarik tipe Deluxe', follow_up: '2099-01-01' })).status, 200);
  const notes = await (await staff('GET', `/api/prospek/${pid}/catatan`)).json();
  assert.equal(notes.length, 1); assert.equal(notes[0].jenis, 'telepon');
  list = await (await staff('GET', '/api/prospek')).json();
  const p = list.prospects.find((x) => x.id === pid);
  assert.equal(p.tahap, 'dihubungi', 'first contact moves a new prospect forward'); assert.equal(p.follow_up, '2099-01-01'); assert.equal(p.terakhir.isi, 'Tertarik tipe Deluxe');
  assert.equal((await staff('PUT', `/api/prospek/${pid}`, { tahap: 'survey' })).status, 200);
  assert.equal((await staff('PUT', `/api/prospek/${pid}`, { tahap: 'deal' })).status, 422);
  assert.equal((await staff('POST', `/api/prospek/${pid}/konversi`, { no_unit: 'KM-1' })).status, 403);
  assert.equal((await staff('DELETE', `/api/prospek/${pid}`)).status, 403);

  // convert: the unit must exist and be reserved/sold
  assert.equal((await boss('POST', '/api/units', { units: [{ no_unit: 'KM-1', type: 'Deluxe' }] })).status, 200);
  assert.equal((await boss('POST', `/api/prospek/${pid}/konversi`, { no_unit: 'KM-1' })).status, 409, 'unit still free');
  assert.equal((await boss('POST', `/api/prospek/${pid}/konversi`, { no_unit: 'NOPE' })).status, 404);
  const jadwal = { reservasi: { tanggal: '2099-01-01', jumlah: '1000000' }, booking: { tanggal: '2099-01-02', jumlah: '5000000' }, kali: 2, mulai: '2099-02-05', cicilan: [{ jumlah: '10000000' }, { jumlah: '10000000' }] };
  assert.equal((await boss('POST', '/api/surat-konfirmasi', await sku('boss', { noUnit: 'KM-1', nama: 'Dewi', cara: { tipe: 'tunai-bertahap' }, jadwal }))).status, 200);
  const conv = await boss('POST', `/api/prospek/${pid}/konversi`, { no_unit: 'KM-1' });
  assert.equal(conv.status, 200); assert.equal((await conv.json()).rate, 2.5, 'rate copied from the sales person');
  assert.equal((await boss('POST', `/api/prospek/${pid}/konversi`, { no_unit: 'KM-1' })).status, 409, 'already a deal');
  assert.equal((await boss('PUT', `/api/komisi/sales/${salesId}`, { rate: 10 })).status, 200);
  const other = (await (await staff('POST', '/api/prospek', { nama: 'Tono', sales_id: salesId })).json()).id;
  assert.equal((await boss('POST', `/api/prospek/${other}/konversi`, { no_unit: 'KM-1' })).status, 409, 'one prospect per unit');
  assert.equal((await boss('DELETE', `/api/prospek/${pid}`)).status, 409, 'a deal carries commission: not deletable');

  // commission = rate x money received (capped at what is due)
  const kw = (o) => boss('POST', '/api/kwitansi', kwDoc({ noUnit: 'KM-1', terimaDari: 'Dewi', ...o }));
  const get = async () => (await (await boss('GET', '/api/komisi')).json());
  let k = await get(); let row = k.sales.find((s) => s.id === salesId);
  assert.equal(row.hak, 0); assert.equal(row.deals[0].rate, 2.5, 'later rate change does not touch the deal');
  assert.equal((await kw({ untuk: 'reservasi', jumlah: 1000000 })).status, 200);
  assert.equal((await kw({ untuk: 'booking', jumlah: 5000000 })).status, 200);
  k = await get(); row = k.sales.find((s) => s.id === salesId);
  assert.equal(row.deals[0].dasar, 6000000); assert.equal(row.hak, 150000); assert.equal(row.sisa, 150000);

  // payouts reduce the balance; correcting one restores it
  assert.equal((await boss('POST', '/api/komisi/payout', { sales_id: salesId, jumlah: 0 })).status, 422);
  const pay = await boss('POST', '/api/komisi/payout', { sales_id: salesId, jumlah: 100000, no_unit: 'KM-1', tanggal: '2026-10-01' });
  assert.equal(pay.status, 200); const payId = (await pay.json()).id;
  k = await get(); row = k.sales.find((s) => s.id === salesId);
  assert.equal(row.sudah, 100000); assert.equal(row.sisa, 50000); assert.equal(k.totals.sisa, 50000);
  assert.equal((await boss('DELETE', `/api/komisi/payout/${payId}`)).status, 200);
  assert.equal((await get()).sales.find((s) => s.id === salesId).sisa, 150000);

  // cancelling the order releases the prospect and removes the commission base
  assert.equal((await boss('POST', '/api/pembatalan', { no_unit: 'KM-1', alasan: 'pembeli', tanggal: '2026-10-05', hangus: 5000000 })).status, 200);
  list = await (await staff('GET', '/api/prospek')).json();
  const lost = list.prospects.find((x) => x.id === pid);
  assert.equal(lost.tahap, 'gagal'); assert.equal(lost.no_unit, '');
  assert.ok((await (await staff('GET', `/api/prospek/${pid}/catatan`)).json()).some((n) => /dibatalkan/.test(n.isi)));
  assert.equal((await get()).sales.find((s) => s.id === salesId).hak, 0);
  assert.equal((await boss('DELETE', `/api/prospek/${other}`)).status, 200, 'an unlinked prospect can be deleted');
});

test('buyer files and KPR: checklist by payment method, stage history, deadline, cleared on cancellation', async () => {
  const boss = (m, u, body) => call(m, u, { as: 'boss', body }), staff = (m, u, body) => call(m, u, { as: 'sales1', body });
  const find = async (no) => (await (await staff('GET', '/api/berkas')).json()).units.find((u) => u.unit === no);
  assert.equal((await boss('POST', '/api/units', { units: [{ no_unit: 'BK-1', type: 'Deluxe' }, { no_unit: 'BK-2', type: 'Deluxe' }] })).status, 200);
  assert.equal((await staff('PUT', '/api/berkas/BK-1/item', { kode: 'ktp', selesai: true })).status, 404, 'a free unit has no file');

  const jadwal = { reservasi: { tanggal: '2099-01-01', jumlah: '1000000' }, booking: { tanggal: '2099-01-02', jumlah: '5000000' }, kali: 2, mulai: '2099-02-05', cicilan: [{ jumlah: '10000000' }, { jumlah: '10000000' }] };
  assert.equal((await boss('POST', '/api/surat-pemesanan', await sku('boss', { noUnit: 'BK-1', nama: 'Kpr Buyer', cara: { tipe: 'kpr' }, jadwal: { booking: jadwal.booking, kali: 2, mulai: '2099-02-05', cicilan: jadwal.cicilan, pelunasan: { tanggal: '2099-06-01', jumlah: '100000000' } } }))).status, 200);
  const kpr = await find('BK-1');
  assert.equal(kpr.cara, 'kpr'); assert.ok(kpr.items.some((i) => i.kode === 'slip'), 'KPR adds bank papers');
  assert.equal(kpr.items.find((i) => i.kode === 'akad').label, 'Akad kredit'); assert.equal(kpr.tahap, 'berkas');

  assert.equal((await boss('POST', '/api/surat-konfirmasi', await sku('boss', { noUnit: 'BK-2', nama: 'Tunai Buyer', cara: { tipe: 'tunai-bertahap' }, jadwal }))).status, 200);
  const tunai = await find('BK-2');
  assert.ok(!tunai.items.some((i) => i.kode === 'slip'), 'cash buyers need no bank papers'); assert.equal(tunai.items.find((i) => i.kode === 'akad').label, 'AJB (akta jual beli)');
  assert.equal((await staff('PUT', '/api/berkas/BK-2', { tahap: 'akad' })).status, 422, 'bank stages are for KPR only');

  assert.equal((await staff('PUT', '/api/berkas/BK-2/item', { kode: 'slip', selesai: true })).status, 422, 'item not in this checklist');
  assert.equal((await staff('PUT', '/api/berkas/BK-2/item', { kode: 'ktp', selesai: true, tanggal: '2026-10-01' })).status, 200);
  let u = await find('BK-2'); assert.equal(u.done, 1); assert.equal(u.items.find((i) => i.kode === 'ktp').tanggal, '2026-10-01');
  assert.equal((await staff('PUT', '/api/berkas/BK-2/item', { kode: 'ktp', selesai: false })).status, 200);
  assert.equal((await find('BK-2')).done, 0, 'ticking off can be undone');

  assert.equal((await staff('PUT', '/api/berkas/BK-1', { tahap: 'nope' })).status, 422);
  assert.equal((await staff('PUT', '/api/berkas/BK-1', { bank: 'BTN', tahap: 'pengajuan', tenggat: '2020-01-01', tenggat_ket: 'Lengkapi slip gaji', tanggal: '2026-10-02' })).status, 200);
  assert.equal((await staff('PUT', '/api/berkas/BK-1', { tahap: 'pengajuan' })).status, 200);
  assert.equal((await staff('PUT', '/api/berkas/BK-1', { tahap: 'sp3k', tanggal: '2026-10-09', catatan_tahap: 'SP3K terbit' })).status, 200);
  const ev = await (await staff('GET', '/api/berkas/BK-1/riwayat')).json();
  assert.deepEqual(ev.map((e) => e.tahap), ['sp3k', 'pengajuan'], 'one event per real stage change, newest first');
  u = await find('BK-1'); assert.equal(u.bank, 'BTN'); assert.equal(u.tahap, 'sp3k'); assert.equal(u.telat, true, 'past deadline while the bank is still working');
  const all = await (await staff('GET', '/api/berkas')).json(); assert.equal(all.stats.telat >= 1, true);
  assert.equal((await staff('PUT', '/api/berkas/BK-1', { tahap: 'cair' })).status, 200);
  assert.equal((await find('BK-1')).telat, false, 'a finished KPR is never late');

  assert.equal((await boss('POST', '/api/pembatalan', { no_unit: 'BK-1', alasan: 'bank', tanggal: '2026-10-10', hangus: 0 })).status, 200);
  assert.equal(await find('BK-1'), undefined, 'the cancelled order drops out');
  assert.deepEqual(await (await staff('GET', '/api/berkas/BK-1/riwayat')).json(), [], 'and its file is cleared');
});

test('progress, photos, punch list and handover (BAST): paid in full first, nothing open, number per year', async () => {
  const boss = (m, u, body) => call(m, u, { as: 'boss', body }), staff = (m, u, body) => call(m, u, { as: 'sales1', body });
  assert.equal((await boss('POST', '/api/units', { units: [{ no_unit: 'PB-1', type: 'Deluxe' }] })).status, 200);
  const one = async (as = 'sales1') => (await (await call('GET', '/api/progres', { as })).json()).units.find((u) => u.unit === 'PB-1');
  assert.equal((await one()).progres, 0);

  assert.equal((await staff('PUT', '/api/progres/PB-1/tahap', { kode: 'nope', persen: 10 })).status, 422);
  assert.equal((await staff('PUT', '/api/progres/PB-1/tahap', { kode: 'pondasi', persen: 101 })).status, 422);
  assert.equal((await staff('PUT', '/api/progres/NOPE/tahap', { kode: 'pondasi', persen: 10 })).status, 404);
  assert.equal((await staff('PUT', '/api/progres/PB-1/tahap', { kode: 'pondasi', persen: 100 })).status, 200);
  assert.equal((await staff('PUT', '/api/progres/PB-1/tahap', { kode: 'struktur', persen: 50, catatan: 'lantai 1 selesai' })).status, 200);
  assert.equal((await one()).progres, 28, '15 + 12.5 rounded');
  const det = await (await staff('GET', '/api/progres/PB-1')).json();
  assert.equal(det.tahap.find((t) => t.kode === 'struktur').catatan, 'lantai 1 selesai');

  // photos: images only, owner or admin may delete
  const post = (as, body, q = '') => fetch(`${base}/api/progres/PB-1/foto?name=tampak.png${q}`, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/octet-stream', Cookie: jar[as] }, body });
  assert.equal((await post('sales1', Buffer.from('%PDF-1.4 not a photo'))).status, 415, 'a PDF is not a photo');
  assert.equal((await post('sales1', PNG, '&kode=zzz')).status, 422);
  const up = await post('sales1', PNG, '&kode=pondasi&ket=cor%20pondasi');
  assert.equal(up.status, 200); const fid = (await up.json()).id;
  const got = await call('GET', `/api/progres/foto/${fid}`, { as: 'boss' });
  assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.equal((await one()).foto, 1);
  assert.equal((await call('GET', `/api/progres/foto/${fid}`)).status, 401);
  assert.equal((await boss('DELETE', `/api/progres/foto/${fid}`)).status, 200);
  assert.equal((await one()).foto, 0);

  // punch list
  assert.equal((await staff('POST', '/api/progres/PB-1/punch', { uraian: '' })).status, 422);
  const pid = (await (await staff('POST', '/api/progres/PB-1/punch', { ruang: 'Dapur', uraian: 'Keramik retak' })).json()).id;
  assert.equal((await one()).punch.open, 1);
  assert.equal((await staff('DELETE', `/api/progres/punch/${pid}`)).status, 403, 'only admin deletes');

  // handover needs an order, full payment and an empty punch list
  const body = { penerima: 'Budi Santoso', tanggal: '2026-10-20' };
  assert.equal((await boss('POST', '/api/progres/PB-1/serah-terima', body)).status, 409, 'free unit');
  const jadwal = { reservasi: { tanggal: '2026-01-01', jumlah: '1000000' }, booking: { tanggal: '2026-01-02', jumlah: '5000000' }, kali: 1, mulai: '2026-02-05', cicilan: [{ jumlah: '4000000' }] };
  assert.equal((await boss('POST', '/api/surat-konfirmasi', await sku('boss', { noUnit: 'PB-1', nama: 'Budi', cara: { tipe: 'tunai-bertahap' }, jadwal }))).status, 200);
  assert.equal((await boss('POST', '/api/progres/PB-1/serah-terima', body)).status, 409, 'not paid');
  const kw = (o) => boss('POST', '/api/kwitansi', kwDoc({ noUnit: 'PB-1', terimaDari: 'Budi', ...o }));
  assert.equal((await kw({ untuk: 'reservasi', jumlah: 1000000, tanggal: '2026-01-01' })).status, 200);
  assert.equal((await kw({ untuk: 'booking', jumlah: 5000000, tanggal: '2026-01-02' })).status, 200);
  assert.equal((await kw({ untuk: 'dp', dpKe: '1', jumlah: 4000000, tanggal: '2026-02-03' })).status, 200);
  const row = await one();
  assert.equal(row.lunas, true); assert.equal(row.acuan, '2026-02-03'); assert.equal(row.target, '2027-02-03'); assert.equal(row.batas, '2027-08-03');
  assert.equal((await staff('POST', '/api/progres/PB-1/serah-terima', body)).status, 409, 'a defect is still open');
  assert.equal((await staff('POST', '/api/progres/PB-1/serah-terima', { ...body, paksa: true })).status, 409, 'staff cannot force');
  assert.equal((await staff('PUT', `/api/progres/punch/${pid}`, { status: 'selesai' })).status, 200);
  assert.equal((await staff('POST', '/api/progres/PB-1/serah-terima', { penerima: '' })).status, 422);
  const ok = await staff('POST', '/api/progres/PB-1/serah-terima', body);
  assert.equal(ok.status, 200); assert.match((await ok.json()).no, /^001\/BAST\/SL-BSS\/X\/2026$/);
  assert.equal((await boss('POST', '/api/progres/PB-1/serah-terima', body)).status, 409, 'only once');
  assert.equal((await staff('POST', '/api/progres/PB-1/punch', { uraian: 'baru' })).status, 409, 'closed after handover');
  assert.equal((await one()).serah.penerima, 'Budi Santoso');
  assert.equal((await staff('GET', '/api/progres/PB-1/denda?sisa=1000')).status, 403);

  const pdfRes = await call('GET', '/api/progres/PB-1/bast.pdf', { as: 'sales1' });
  if (pdf.available()) { assert.equal(pdfRes.status, 200); assert.equal(pdfRes.headers.get('content-type'), 'application/pdf'); assert.equal((await pdfRes.arrayBuffer()).byteLength > 1000, true); }
  assert.equal((await call('GET', '/api/progres/PB-2/bast.pdf', { as: 'sales1' })).status, 404);
});

test('handover can be forced by an admin with the open work printed, and a late fee is for admins', async () => {
  const boss = (m, u, body) => call(m, u, { as: 'boss', body });
  assert.equal((await boss('POST', '/api/units', { units: [{ no_unit: 'PB-2', type: 'Deluxe' }] })).status, 200);
  const jadwal = { reservasi: { tanggal: '2020-01-01', jumlah: '1000000' }, booking: { tanggal: '2020-01-02', jumlah: '5000000' }, kali: 1, mulai: '2020-02-05', cicilan: [{ jumlah: '4000000' }] };
  assert.equal((await boss('POST', '/api/surat-konfirmasi', await sku('boss', { noUnit: 'PB-2', nama: 'Siti', cara: { tipe: 'tunai-bertahap' }, jadwal }))).status, 200);
  for (const [untuk, j, t, extra] of [['reservasi', 1000000, '2020-01-01', {}], ['booking', 5000000, '2020-01-02', {}], ['dp', 4000000, '2020-02-03', { dpKe: '1' }]]) {
    assert.equal((await boss('POST', '/api/kwitansi', kwDoc({ noUnit: 'PB-2', terimaDari: 'Siti', untuk, jumlah: j, tanggal: t, ...extra }))).status, 200);
  }
  assert.equal((await boss('POST', '/api/progres/PB-2/punch', { ruang: 'Kamar', uraian: 'Cat belum rata' })).status, 200);
  const row = (await (await boss('GET', '/api/progres')).json()).units.find((u) => u.unit === 'PB-2');
  assert.ok(row.hariTelat > 1000, 'handover is years past due'); assert.equal(row.batas, '2021-08-03');
  const d = await (await boss('GET', `/api/progres/PB-2/denda?sisa=100000000`)).json();
  assert.equal(d.denda, 3000000, 'capped at 3% of the unfinished work'); assert.equal(d.maks, 3000000);
  const ok = await boss('POST', '/api/progres/PB-2/serah-terima', { penerima: 'Siti', tanggal: '2026-10-21', paksa: true, sisa_pekerjaan: 2000000, catatan: 'Diserahkan dengan catatan' });
  assert.equal(ok.status, 200);
  const data = await (await boss('GET', '/api/progres/PB-2')).json();
  assert.equal(data.serahDetail.dipaksa, true); assert.equal(data.serahDetail.sisa, 2000000);
  const staffView = await (await call('GET', '/api/progres/PB-2', { as: 'sales1' })).json();
  assert.equal(staffView.serahDetail.sisa, undefined, 'the value of unfinished work is not shown to staff');
  assert.equal((await boss('POST', '/api/pembatalan', { no_unit: 'PB-2', alasan: 'lainnya', tanggal: '2026-10-22', hangus: 0 })).status, 200);
  assert.equal((await (await boss('GET', '/api/progres/PB-2')).json()).serah, null, 'the handover belongs to the order and goes with it');
});

test('warehouse: stock is the ledger, issues cost the moving average, no overdraw, corrections, values for admins only', async () => {
  const boss = (m, u, body) => call(m, u, { as: 'boss', body }), staff = (m, u, body) => call(m, u, { as: 'sales1', body });
  assert.equal((await staff('POST', '/api/gudang/material', { kode: 'X', nama: 'X', satuan: 'sak' })).status, 403, 'master data is admin only');
  assert.equal((await boss('POST', '/api/gudang/material', { kode: 'SMN', nama: 'Semen', satuan: '' })).status, 422);
  const mat = await boss('POST', '/api/gudang/material', { kode: 'SMN', nama: 'Semen 50kg', satuan: 'sak', minimum: 20 });
  assert.equal(mat.status, 200); const mid = (await mat.json()).id;
  assert.equal((await boss('POST', '/api/gudang/material', { kode: 'smn', nama: 'dup', satuan: 'sak' })).status, 409, 'same code twice');
  const snap = async (as = 'boss') => (await (await call('GET', '/api/gudang', { as })).json());
  const gid = (await snap()).gudang[0].id;
  const g2 = (await (await boss('POST', '/api/gudang/lokasi', { nama: 'Gudang Lapangan' })).json()).id;
  assert.equal((await boss('POST', '/api/gudang/lokasi', { nama: 'gudang lapangan' })).status, 409);

  const tx = (o, who = 'sales1') => call('POST', '/api/gudang/transaksi', { as: who, body: { material_id: mid, gudang_id: gid, tanggal: '2026-10-01', ...o } });
  assert.equal((await tx({ jenis: 'masuk', qty: 0 })).status, 422);
  assert.equal((await tx({ jenis: 'masuk', qty: 'abc' })).status, 422);
  assert.equal((await tx({ jenis: 'jual', qty: 1 })).status, 422);
  assert.equal((await tx({ jenis: 'keluar', qty: 1 })).status, 409, 'nothing in stock yet');
  assert.equal((await tx({ jenis: 'masuk', qty: 100, harga: 60000, pihak: 'TB Maju', ref: 'SJ-1' })).status, 200);
  assert.equal((await tx({ jenis: 'masuk', qty: 100, harga: 70000 })).status, 200);
  let m = (await snap()).material.find((x) => x.id === mid);
  assert.equal(m.stok, 200); assert.equal(m.nilai, 13000000); assert.equal(m.rata, 65000, 'average of 60.000 and 70.000');
  assert.equal((await snap('sales1')).material.find((x) => x.id === mid).nilai, undefined, 'staff see quantities only');
  assert.equal((await snap('sales1')).stats.nilai, undefined);

  assert.equal((await tx({ jenis: 'keluar', qty: 201 })).status, 409, 'cannot take more than is there');
  assert.equal((await tx({ jenis: 'keluar', qty: 10, no_unit: 'NOPE' })).status, 422);
  assert.equal((await boss('POST', '/api/units', { units: [{ no_unit: 'GD-1', type: 'Deluxe' }] })).status, 200);
  assert.equal((await tx({ jenis: 'keluar', qty: 30, no_unit: 'gd-1', pihak: 'Mandor Ali' })).status, 200);
  m = (await snap()).material.find((x) => x.id === mid);
  assert.equal(m.stok, 170); assert.equal(m.nilai, 13000000 - 30 * 65000);
  const use = await (await boss('GET', '/api/gudang/pemakaian')).json();
  assert.deepEqual(use.map((u) => [u.unit, u.items[0].qty, u.items[0].nilai, u.nilai]), [['GD-1', 30, 1950000, 1950000]], 'usage per unit with its cost, unit name as registered');
  assert.equal((await (await staff('GET', '/api/gudang/pemakaian')).json())[0].items[0].nilai, undefined);

  // transfer: stock moves, value does not
  assert.equal((await tx({ jenis: 'mutasi', qty: 50, ke_gudang_id: gid })).status, 422, 'same warehouse');
  assert.equal((await tx({ jenis: 'mutasi', qty: 500, ke_gudang_id: g2 })).status, 409);
  assert.equal((await tx({ jenis: 'mutasi', qty: 50, ke_gudang_id: g2 })).status, 200);
  m = (await snap()).material.find((x) => x.id === mid);
  assert.equal(m.perGudang[gid], 120); assert.equal(m.perGudang[g2], 50); assert.equal(m.stok, 170); assert.equal(m.nilai, 13000000 - 1950000);
  assert.equal((await boss('PUT', `/api/gudang/lokasi/${g2}`, { aktif: false })).status, 409, 'a warehouse with stock cannot be closed');

  // opname: counted stock replaces the system figure
  assert.equal((await tx({ jenis: 'opname', qty: 120 })).status, 422, 'same as the system');
  assert.equal((await tx({ jenis: 'opname', qty: 118 })).status, 200);
  m = (await snap()).material.find((x) => x.id === mid);
  assert.equal(m.perGudang[gid], 118); assert.equal(m.stok, 168);

  // low-stock flag
  assert.equal((await tx({ jenis: 'keluar', qty: 150, gudang_id: gid })).status, 409);
  assert.equal((await tx({ jenis: 'keluar', qty: 118 })).status, 200);
  assert.equal((await tx({ jenis: 'keluar', qty: 38, gudang_id: g2 })).status, 200);
  m = (await snap()).material.find((x) => x.id === mid);
  assert.equal(m.stok, 12); assert.equal(m.bawah, true, '12 is at or under the minimum of 20'); assert.equal((await snap()).stats.bawah, 1);

  // corrections: admin only, once, and only when the stock is still there
  const hist = await (await staff('GET', `/api/gudang/riwayat?material_id=${mid}`)).json();
  assert.equal(hist[0].nilai, undefined, 'values hidden from staff'); assert.ok(hist.length >= 8);
  const issue = hist.find((h) => h.jenis === 'keluar' && h.no_unit === 'GD-1');
  assert.equal((await staff('POST', `/api/gudang/riwayat/${issue.id}/batalkan`)).status, 403);
  assert.equal((await boss('POST', `/api/gudang/riwayat/${issue.id}/batalkan`)).status, 200);
  assert.equal((await boss('POST', `/api/gudang/riwayat/${issue.id}/batalkan`)).status, 409, 'only once');
  assert.deepEqual((await (await boss('GET', '/api/gudang/pemakaian')).json()), [], 'the cancelled issue no longer counts for the unit');
  m = (await snap()).material.find((x) => x.id === mid);
  assert.equal(m.stok, 42); assert.equal(m.nilai, 2730000, '780.000 left + the 1.950.000 the issue had cost');
  const first = (await (await boss('GET', `/api/gudang/riwayat?material_id=${mid}`)).json()).filter((h) => h.jenis === 'masuk');
  assert.equal((await boss('POST', `/api/gudang/riwayat/${first[first.length - 1].id}/batalkan`)).status, 409, 'the receipt cannot be undone: that stock is gone');
});

test('finance: cash from receipts, commission and refunds is read in; manual lines; SPK terms create the cash line; admin only', async () => {
  const boss = (m, u, body) => call(m, u, { as: 'boss', body }), staff = (m, u, body) => call(m, u, { as: 'sales1', body });
  assert.equal((await staff('GET', '/api/keuangan')).status, 403);
  assert.equal((await staff('POST', '/api/keuangan/spk', {})).status, 403);
  const bulan = '2031-05';
  const get = async (b = bulan) => (await (await boss('GET', `/api/keuangan?bulan=${b}`)).json());

  // a receipt in that month is income without anyone typing it again
  assert.equal((await boss('POST', '/api/units', { units: [{ no_unit: 'KU-1', type: 'Deluxe' }] })).status, 200);
  assert.equal((await boss('POST', '/api/kwitansi', kwDoc({ noUnit: 'KU-1', terimaDari: 'Pembeli KU', untuk: 'booking', jumlah: 5000000, tanggal: `${bulan}-03` }))).status, 200);
  let k = await get();
  assert.equal(k.ringkasan.masuk, 5000000); assert.equal(k.ringkasan.dariKwitansi, 5000000); assert.equal(k.ringkasan.keluar, 0);
  assert.equal(k.transaksi[0].sumber, 'kwitansi'); assert.equal(k.transaksi[0].hapus, false);

  // manual lines: validated, and the automatic categories cannot be typed in by hand
  const kas = (o) => boss('POST', '/api/keuangan/kas', { tanggal: `${bulan}-05`, ...o });
  assert.equal((await kas({ jenis: 'keluar', kategori: 'material', jumlah: 0 })).status, 422);
  assert.equal((await kas({ jenis: 'keluar', kategori: 'penjualan', jumlah: 1000 })).status, 422, 'wrong direction');
  assert.equal((await kas({ jenis: 'keluar', kategori: 'komisi', jumlah: 1000 })).status, 422, 'would count twice');
  assert.equal((await kas({ jenis: 'keluar', kategori: 'material', jumlah: 1000, no_unit: 'NOPE' })).status, 422);
  const m1 = await kas({ jenis: 'keluar', kategori: 'material', jumlah: 1500000, pihak: 'TB Maju', keterangan: 'Semen', no_unit: 'ku-1' });
  assert.equal(m1.status, 200); const mid = (await m1.json()).id;
  assert.equal((await kas({ jenis: 'masuk', kategori: 'lain', jumlah: 250000 })).status, 200);
  k = await get();
  assert.equal(k.ringkasan.masuk, 5250000); assert.equal(k.ringkasan.keluar, 1500000); assert.equal(k.ringkasan.saldo, 3750000);
  assert.equal(k.transaksi.find((t) => t.id === mid).no_unit, 'KU-1');
  assert.equal((await get('2031-06')).ringkasan.masuk, 0, 'another month is empty');
  assert.equal((await boss('DELETE', `/api/keuangan/kas/${mid}`)).status, 200);
  assert.equal((await get()).ringkasan.keluar, 0);

  // commission payouts appear as money out
  const sid = (await (await boss('POST', '/api/komisi/sales', { nama: 'Sales Kas', rate: 1 })).json()).id;
  assert.equal((await boss('POST', '/api/komisi/payout', { sales_id: sid, jumlah: 200000, tanggal: `${bulan}-07` })).status, 200);
  k = await get(); assert.equal(k.ringkasan.komisi, 200000); assert.equal(k.ringkasan.keluar, 200000);

  // contractor and SPK: terms must add up to the value; paying a term writes the cash line; undoing removes it
  const kid = (await (await boss('POST', '/api/keuangan/kontraktor', { nama: 'CV Karya Bangun' })).json()).id;
  assert.equal((await boss('POST', '/api/keuangan/kontraktor', { nama: 'cv karya bangun' })).status, 409);
  const spk = (o) => boss('POST', '/api/keuangan/spk', { no_spk: 'SPK-001', kontraktor_id: kid, uraian: 'Struktur D-02', units: 'D-02', nilai: 100000000, tanggal: `${bulan}-01`, termin: [{ uraian: 'DP 30%', jumlah: 30000000, jatuh_tempo: '2020-01-01' }, { uraian: 'Pelunasan', jumlah: 70000000, jatuh_tempo: '2099-01-01' }], ...o });
  assert.equal((await spk({ termin: [{ uraian: 'DP', jumlah: 30000000 }] })).status, 422, 'terms do not add up');
  assert.equal((await spk({ termin: [] })).status, 422);
  assert.equal((await spk({ kontraktor_id: 9999 })).status, 422);
  assert.equal((await spk()).status, 200);
  assert.equal((await spk()).status, 409, 'SPK number is unique');
  let list = await (await boss('GET', '/api/keuangan/spk')).json();
  const s1 = list[0]; assert.equal(s1.sisa, 100000000); assert.equal(s1.telat, true, 'the DP term is past due'); assert.equal(s1.termin[0].telat, true);
  assert.equal((await get()).ringkasan.hutangSpk, 100000000);
  assert.equal((await boss('POST', `/api/keuangan/termin/${s1.termin[0].id}/bayar`, { tanggal: `${bulan}-10` })).status, 200);
  assert.equal((await boss('POST', `/api/keuangan/termin/${s1.termin[0].id}/bayar`, {})).status, 409, 'paid once');
  k = await get(); assert.equal(k.ringkasan.keluar, 200000 + 30000000); assert.equal(k.ringkasan.hutangSpk, 70000000);
  const line = k.transaksi.find((t) => t.sumber === 'termin'); assert.equal(line.pihak, 'CV Karya Bangun'); assert.equal(line.ref, 'SPK-001');
  assert.equal((await boss('DELETE', `/api/keuangan/kas/${line.id}`)).status, 409, 'undo from the SPK, not the cash list');
  list = await (await boss('GET', '/api/keuangan/spk')).json(); assert.equal(list[0].persen, 30); assert.equal(list[0].telat, false);
  assert.equal((await boss('POST', `/api/keuangan/termin/${s1.termin[0].id}/batal`)).status, 200);
  assert.equal((await get()).ringkasan.keluar, 200000, 'the cash line went with the undone payment');
  assert.equal((await boss('PUT', `/api/keuangan/spk/${s1.id}`, { status: 'batal' })).status, 200);
  assert.equal((await boss('POST', `/api/keuangan/termin/${s1.termin[0].id}/bayar`, {})).status, 409, 'cancelled SPK cannot be paid');
  assert.equal((await get()).ringkasan.hutangSpk, 0, 'a cancelled SPK is no longer owed');
  assert.equal((await boss('PUT', `/api/keuangan/spk/${s1.id}`, { status: 'x' })).status, 422);
});
