// Domain logic on top of PostgreSQL: documents, unit stock, users, audit trail.
const db = require('./db');
const numbering = require('./numbering');
const { HttpError, hashPassword, verifyPassword, checkPasswordStrength } = require('./auth');

const str = (v) => (v == null ? '' : String(v).trim());
const int = (v) => (str(v) !== '' && Number.isFinite(+v) ? Math.round(+v) : null);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);

// Person on each document type, and which types reserve a unit.
const WHO = { 'surat-konfirmasi': 'nama', 'surat-pemesanan': 'nama', kwitansi: 'terimaDari', 'tanda-terima': 'kepada' };
const HOLDS_UNIT = new Set(['surat-konfirmasi', 'surat-pemesanan', 'kwitansi']);
const STATUS = ['tersedia', 'dipesan', 'terjual'];
const TS = (col) => `to_char(${col} AT TIME ZONE '${require('./config').timezone}', 'YYYY-MM-DD HH24:MI')`;

async function audit(c, userId, action, entity, entityId, detail) {
  await c.query('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [userId || null, action, entity || null, entityId == null ? null : String(entityId), detail ? JSON.stringify(detail) : null]);
}

// ───────── documents ─────────
const validation = require('../lib/validation');
const isObj = (d) => d && typeof d === 'object' && !Array.isArray(d);

function assertComplete(jenis, d) {
  const miss = validation.missing(jenis, d);
  if (miss.length) throw new HttpError(422, 'Lengkapi dulu: ' + miss.join(', ') + '.', { missing: miss });
}

// A unit document may only claim a free unit; receipts (Kwitansi) can always be issued for a unit,
// because further payments on an already sold unit are normal.
const unitBusyMessage = (u) => `Unit ${u.no_unit} sudah berstatus "${u.status}"${u.pemesan ? ' atas nama ' + u.pemesan : ''}${u.doc_no ? ' (' + u.doc_no + ')' : ''}. Ubah statusnya di menu Stok Unit bila ingin memakainya lagi.`;
const lockUnit = async (c, no) => (str(no) ? (await c.query('SELECT * FROM units WHERE lower(no_unit) = lower($1) FOR UPDATE', [str(no)])).rows[0] || null : null);
// SKU/SPU reserve a unit ("dipesan"); a Kwitansi marks it "terjual".
const statusFor = (jenis) => (jenis === 'kwitansi' ? 'terjual' : 'dipesan');

// Checks the uploads named in doc.files belong to this document (or are fresh ones from this user).
async function claimFiles(c, jenis, doc, user, attached = {}) {
  const files = {};
  for (const kind of validation.filesFor(jenis, doc)) {
    const id = str(doc.files && doc.files[kind]);
    if (!id) continue;
    const r = (await c.query('SELECT user_id, document_id FROM uploads WHERE id::text = $1 AND kind = $2 FOR UPDATE', [id, kind])).rows[0];
    const mine = attached[kind] === id;
    if (!r || (!mine && (r.document_id != null || (r.user_id !== user.id && user.role !== 'admin')))) {
      throw new HttpError(422, `Berkas ${validation.FILE_KINDS[kind]} tidak valid atau sudah dipakai. Unggah ulang.`, { missing: [`Unggah ${validation.FILE_KINDS[kind]}`] });
    }
    files[kind] = id;
  }
  return files;
}
const attachFiles = async (c, docId, files) => {
  const ids = Object.values(files);
  await c.query('DELETE FROM uploads WHERE document_id = $1 AND NOT (id::text = ANY($2))', [docId, ids]); // replaced / dropped
  if (ids.length) await c.query('UPDATE uploads SET document_id = $1 WHERE id::text = ANY($2)', [docId, ids]);
};

// One transaction: validate → lock unit → take number → render → save → reserve unit.
// If anything fails nothing is saved and no number is used.
async function createDocument(jenis, data, user, render) {
  if (!isObj(data)) throw new HttpError(400, 'Data dokumen tidak valid.');
  assertComplete(jenis, data);
  return db.tx(async (c) => {
    const unit = HOLDS_UNIT.has(jenis) ? await lockUnit(c, data.noUnit) : null;
    if (unit && jenis !== 'kwitansi' && unit.status === 'terjual') throw new HttpError(409, unitBusyMessage(unit));
    const no = await numbering.take(c, data.tanggal);
    const doc = { ...data, no };
    if (unit) doc.noUnit = unit.no_unit; // canonical spelling from stock
    doc.files = await claimFiles(c, jenis, doc, user);
    const buffer = await render(doc);
    const ins = await c.query(
      'INSERT INTO documents (no, jenis, nama, no_unit, jumlah, tanggal, data, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [no, jenis, str(doc[WHO[jenis]]), str(doc.noUnit), int(doc.jumlah ?? doc.harga), isoDate(doc.tanggal), JSON.stringify(doc), user.id]);
    const id = ins.rows[0].id;
    await attachFiles(c, id, doc.files);
    if (unit) {
      const next = jenis === 'kwitansi' && unit.status === 'terjual' ? unit.status : statusFor(jenis); // never step a sold unit back
      const keepOwner = jenis === 'kwitansi' && unit.status === 'terjual';
      await c.query('UPDATE units SET status=$1, pemesan=$2, doc_no=$3, updated_by=$4, updated_at=now() WHERE id=$5',
        [next, keepOwner ? unit.pemesan : (str(doc[WHO[jenis]]) || unit.pemesan), keepOwner ? unit.doc_no : no, user.id, unit.id]);
      await audit(c, user.id, next === 'terjual' ? 'unit.sold' : 'unit.reserve', 'unit', unit.id, { no_unit: unit.no_unit, doc_no: no });
    }
    await audit(c, user.id, 'document.create', 'document', id, { no, jenis });
    return { buffer, doc, id };
  });
}

// Correct a printed document (admin only — enforced by the route). Number and PDF archive slot stay;
// the PDF is rebuilt by the caller afterwards.
async function updateDocument(id, data, user, render) {
  if (!isObj(data)) throw new HttpError(400, 'Data dokumen tidak valid.');
  return db.tx(async (c) => {
    const old = (await c.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw new HttpError(404, 'Dokumen tidak ditemukan.');
    const jenis = old.jenis;
    const attached = Object.fromEntries((await c.query('SELECT kind, id::text AS id FROM uploads WHERE document_id = $1', [id])).rows.map((r) => [r.kind, r.id]));
    const merged = { ...data, no: old.no, files: { ...attached, ...(isObj(data.files) ? data.files : {}) } };
    assertComplete(jenis, merged);

    const oldUnit = HOLDS_UNIT.has(jenis) ? await lockUnit(c, old.no_unit) : null;
    const newUnit = HOLDS_UNIT.has(jenis) ? await lockUnit(c, merged.noUnit) : null;
    const moved = newUnit && (!oldUnit || newUnit.id !== oldUnit.id);
    if (moved && jenis !== 'kwitansi' && newUnit.status === 'terjual') throw new HttpError(409, unitBusyMessage(newUnit)); // same rule as issuing a new document
    if (newUnit) merged.noUnit = newUnit.no_unit;
    merged.files = await claimFiles(c, jenis, merged, user, attached);
    await render(merged); // fail before anything is written

    await c.query(
      'UPDATE documents SET nama=$1, no_unit=$2, jumlah=$3, tanggal=$4, data=$5, pdf=NULL, edited_at=now(), edited_by=$6 WHERE id=$7',
      [str(merged[WHO[jenis]]), str(merged.noUnit), int(merged.jumlah ?? merged.harga), isoDate(merged.tanggal), JSON.stringify(merged), user.id, id]);
    await attachFiles(c, id, merged.files);

    // Unit stock follows the correction: free the old unit if this document was holding it, then hold the new one.
    if (oldUnit && moved || (oldUnit && !newUnit)) {
      if (oldUnit.doc_no === old.no) await c.query("UPDATE units SET status='tersedia', pemesan='', doc_no='', updated_by=$1, updated_at=now() WHERE id=$2", [user.id, oldUnit.id]);
    }
    if (newUnit && moved) {
      await c.query('UPDATE units SET status=$1, pemesan=$2, doc_no=$3, updated_by=$4, updated_at=now() WHERE id=$5',
        [statusFor(jenis), str(merged[WHO[jenis]]) || newUnit.pemesan, old.no, user.id, newUnit.id]);
    } else if (newUnit && newUnit.doc_no === old.no) {
      await c.query('UPDATE units SET pemesan=$1, updated_by=$2, updated_at=now() WHERE id=$3', [str(merged[WHO[jenis]]) || newUnit.pemesan, user.id, newUnit.id]);
    }
    const changed = Object.keys({ ...old.data, ...merged }).filter((k) => JSON.stringify(old.data[k]) !== JSON.stringify(merged[k]));
    await audit(c, user.id, 'document.edit', 'document', id, { no: old.no, jenis, changed });
    return { doc: merged, id, jenis };
  });
}

// One page of the document history (newest first). `per` is limited to a few sizes; a page past the end
// returns the last page, so a stale page number after filtering never shows an empty table.
const DOC_PAGE_SIZES = [10, 25, 50, 100];
async function listDocuments({ q = '', jenis = '', page = 1, per = 25 } = {}) {
  const like = `%${str(q)}%`, kind = str(jenis);
  const size = DOC_PAGE_SIZES.includes(Number(per)) ? Number(per) : 25;
  const where = "WHERE ($1 = '' OR d.jenis = $1) AND (d.no ILIKE $2 OR d.nama ILIKE $2 OR d.no_unit ILIKE $2)";
  const total = (await db.query(`SELECT count(*)::int AS n FROM documents d ${where}`, [kind, like])).rows[0].n;
  const pages = Math.max(1, Math.ceil(total / size));
  const cur = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), pages);
  const r = await db.query(
    `SELECT d.id, d.no, d.jenis, d.nama, d.no_unit, d.jumlah, d.tanggal, ${TS('d.created_at')} AS created_at, u.name AS created_by,
            d.edited_at IS NOT NULL AS edited,
            (SELECT json_agg(json_build_object('kind', f.kind, 'id', f.id::text, 'filename', f.filename, 'mime', f.mime, 'size', f.size) ORDER BY f.kind) FROM uploads f WHERE f.document_id = d.id) AS files
     FROM documents d LEFT JOIN users u ON u.id = d.created_by
     ${where}
     ORDER BY d.id DESC LIMIT $3 OFFSET $4`, [kind, like, size, (cur - 1) * size]);
  return { rows: r.rows, total, page: cur, per: size, pages };
}
const getDocument = async (id) => (await db.query('SELECT id, no, jenis, nama, no_unit, jumlah, tanggal, data, created_by, created_at, pdf IS NOT NULL AS has_pdf FROM documents WHERE id = $1', [id])).rows[0] || null;
const getDocumentFiles = async (id) => (await db.query('SELECT kind, id::text AS id, filename, mime, size FROM uploads WHERE document_id = $1 ORDER BY kind', [id])).rows;
const getPdf = async (id) => (await db.query('SELECT pdf FROM documents WHERE id = $1', [id])).rows[0]?.pdf || null;
const savePdf = (id, buf) => db.query('UPDATE documents SET pdf = $1 WHERE id = $2', [buf, id]);

// ───────── uploads (customer documents) ─────────
async function saveUpload({ user, kind, filename, mime, data }) {
  const r = await db.query('INSERT INTO uploads (user_id, kind, filename, mime, size, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text AS id',
    [user.id, kind, filename, mime, data.length, data]);
  return { id: r.rows[0].id, kind, filename, mime, size: data.length };
}
const getUpload = async (id) => (/^[0-9a-f-]{36}$/i.test(str(id)) ? (await db.query('SELECT id::text AS id, kind, filename, mime, size, data, user_id, document_id FROM uploads WHERE id = $1', [id])).rows[0] : null) || null;
async function deleteUpload(id, user) {
  const u = await getUpload(id);
  if (!u) return false;
  if (u.document_id != null) throw new HttpError(409, 'Berkas ini sudah menjadi bagian dari dokumen yang tercetak.');
  if (u.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Berkas ini bukan milik Anda.');
  await db.query('DELETE FROM uploads WHERE id = $1', [id]);
  return true;
}
// Files that were uploaded but never attached to a printed document.
const purgeOrphanUploads = () => db.query("DELETE FROM uploads WHERE document_id IS NULL AND created_at < now() - interval '1 day'");

// ───────── units ─────────
// For a unit that is reserved or sold: the value (Harga Pengikatan) and the buyer's name from its most recent
// SKU / SPU, so the stock list and the map can show who has it and for how much.
const listUnits = async () => (await db.query(
  `SELECT u.id, u.no_unit, u.type, u.harga, u.status, u.pemesan, u.doc_no,
          COALESCE(NULLIF(b.nama, ''), NULLIF(u.pemesan, '')) AS pemesan_terakhir,
          CASE WHEN b.data->>'harga' ~ '^[0-9]+$' THEN (b.data->>'harga')::bigint END AS nilai,
          b.no AS booking_no, b.tanggal AS booking_tanggal
   FROM units u
   LEFT JOIN LATERAL (
     SELECT d.nama, d.no, d.tanggal, d.data FROM documents d
     WHERE d.jenis IN ('surat-konfirmasi', 'surat-pemesanan') AND lower(d.no_unit) = lower(u.no_unit)
     ORDER BY d.id DESC LIMIT 1) b ON u.status <> 'tersedia'
   ORDER BY u.type, u.no_unit`)).rows;

async function addUnits(rows, user) {
  return db.tx(async (c) => {
    let added = 0; const skipped = [];
    for (const r of rows) {
      const no = str(r.no_unit);
      if (!no) continue;
      const res = await c.query(
        `INSERT INTO units (no_unit, type, harga, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (lower(no_unit)) DO NOTHING RETURNING id`, [no, str(r.type), int(r.harga), user.id]);
      if (res.rowCount) added += 1; else skipped.push(no);
    }
    if (added) await audit(c, user.id, 'unit.add', 'unit', null, { added });
    return { added, skipped };
  });
}

const UNIT_DETAIL_FIELDS = ['no_unit', 'type', 'harga'];

async function updateUnit(id, f, user) {
  return db.tx(async (c) => {
    const u = (await c.query('SELECT * FROM units WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!u) throw new HttpError(404, 'Unit tidak ditemukan.');
    const status = f.status ?? u.status;
    if (!STATUS.includes(status)) throw new HttpError(400, 'Status tidak valid.');
    const editsDetails = UNIT_DETAIL_FIELDS.some((k) => f[k] !== undefined);
    const no = f.no_unit !== undefined ? str(f.no_unit) : u.no_unit;
    if (!no) throw new HttpError(400, 'Nomor unit wajib diisi.');
    const free = status === 'tersedia';
    try {
      await c.query(
        `UPDATE units SET no_unit=$1, type=$2, harga=$3, status=$4, pemesan=$5, doc_no=$6, updated_by=$7, updated_at=now() WHERE id=$8`,
        [no, f.type !== undefined ? str(f.type) : u.type, f.harga !== undefined ? int(f.harga) : u.harga,
          status, free ? '' : (f.pemesan ?? u.pemesan), free ? '' : (f.doc_no ?? u.doc_no), user.id, id]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, `Nomor unit "${no}" sudah dipakai unit lain.`);
      throw e;
    }
    if (status !== u.status) await audit(c, user.id, 'unit.status', 'unit', id, { no_unit: u.no_unit, from: u.status, to: status });
    if (editsDetails) await audit(c, user.id, 'unit.edit', 'unit', id, { no_unit: no, before: { no_unit: u.no_unit, type: u.type, harga: u.harga } });
  });
}
async function deleteUnit(id, user) {
  const r = await db.query('DELETE FROM units WHERE id = $1 RETURNING no_unit', [id]);
  if (r.rowCount) await audit(db, user.id, 'unit.delete', 'unit', id, { no_unit: r.rows[0].no_unit });
}

// A cancelled order closes the unit's cycle: its documents up to `doc_cutoff` no longer count anywhere.
const CUT = (a) => `COALESCE((SELECT max(c.doc_cutoff) FROM cancellations c WHERE lower(c.no_unit) = lower(${a}.no_unit)), 0)`;

// ───────── sales report ─────────
const CARA_LABEL = { 'tunai-keras': 'Tunai Keras', 'tunai-bertahap': 'Tunai Bertahap', kpr: 'KPR' };

// A "sale" = the latest SKU/SPU of a unit that is still reserved/sold (cancelled units drop out).
// A reserved/sold unit that has no SKU/SPU at all (e.g. only a receipt was made) is listed too, flagged `tanpaSurat`,
// with no price: it counts as a unit but adds nothing to the value until its SKU/SPU exists.
// Period filters on the document date. Stock figures are always current.
async function salesReport({ from, to } = {}) {
  const f = isoDate(from), t = isoDate(to);
  const sold = (await db.query(
    `SELECT x.id, x.no, x.jenis, x.nama, x.no_unit, x.tanggal, x.data, x.type, x.status FROM (
       SELECT DISTINCT ON (lower(d.no_unit)) d.id, d.no, d.jenis, d.nama, d.no_unit, d.tanggal, d.data, u.type, u.status
       FROM documents d JOIN units u ON lower(u.no_unit) = lower(d.no_unit) AND u.status <> 'tersedia'
       WHERE d.jenis IN ('surat-konfirmasi', 'surat-pemesanan') AND d.no_unit <> '' AND d.id > ${CUT('d')}
       ORDER BY lower(d.no_unit), d.id DESC) x
     WHERE ($1::date IS NULL OR x.tanggal >= $1) AND ($2::date IS NULL OR x.tanggal <= $2)
     ORDER BY x.tanggal DESC NULLS LAST, x.id DESC`, [f, t])).rows;
  // Name, number and date come from the unit's own latest document (the stock card can be blank, e.g. after a manual
  // status change), then from what the card remembers.
  const noLetter = (await db.query(
    `SELECT u.no_unit, u.type, u.status, u.pemesan, u.doc_no, d.id, d.no, d.nama, d.jenis, d.tanggal
     FROM units u
     LEFT JOIN LATERAL (
       SELECT x.id, x.no, x.nama, x.jenis, x.tanggal FROM documents x
       WHERE lower(x.no_unit) = lower(u.no_unit) AND x.id > ${CUT('x')} ORDER BY x.id DESC LIMIT 1) d ON true
     WHERE u.status <> 'tersedia'
       AND NOT EXISTS (SELECT 1 FROM documents s WHERE lower(s.no_unit) = lower(u.no_unit) AND s.jenis IN ('surat-konfirmasi', 'surat-pemesanan') AND s.id > ${CUT('s')})
       AND ($1::date IS NULL OR d.tanggal >= $1) AND ($2::date IS NULL OR d.tanggal <= $2)
     ORDER BY d.tanggal DESC NULLS LAST, u.id DESC`, [f, t])).rows;
  const rows = [
    ...sold.map((r) => ({
      id: r.id, tanggal: r.tanggal, no: r.no, jenis: r.jenis, nama: r.nama, unit: r.no_unit, type: r.type || '',
      harga: Number(r.data && r.data.harga) || 0, cara: CARA_LABEL[r.data && r.data.cara && r.data.cara.tipe] || '—',
      sales: str(r.data && r.data.sales) || '—', status: r.status, tanpaSurat: false,
    })),
    ...noLetter.map((r) => ({
      id: r.id ?? null, tanggal: r.tanggal || null, no: r.no || r.doc_no || '—', jenis: r.jenis || '', nama: str(r.pemesan) || str(r.nama), unit: r.no_unit, type: r.type || '',
      harga: 0, cara: 'Tanpa SKU/SPU', sales: 'Tanpa SKU/SPU', status: r.status, tanpaSurat: true,
    })),
  ];
  const group = (keyFn) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); const g = m.get(k) || { key: k, jumlah: 0, nilai: 0 }; g.jumlah += 1; g.nilai += r.harga; m.set(k, g); }
    return [...m.values()];
  };
  const sum = (list) => ({ jumlah: list.length, nilai: list.reduce((a, r) => a + r.harga, 0) });

  const units = (await db.query('SELECT type, status, count(*)::int n FROM units GROUP BY type, status')).rows;
  const stock = { total: 0, tersedia: 0, dipesan: 0, terjual: 0, byType: {} };
  for (const u of units) {
    stock.total += u.n; stock[u.status] = (stock[u.status] || 0) + u.n;
    const t2 = (stock.byType[u.type || '—'] ||= { total: 0, tersedia: 0, dipesan: 0, terjual: 0 });
    t2.total += u.n; t2[u.status] += u.n;
  }
  const rec = (await db.query(
    "SELECT count(*)::int n, COALESCE(sum(jumlah), 0)::bigint total FROM documents WHERE jenis = 'kwitansi' AND ($1::date IS NULL OR tanggal >= $1) AND ($2::date IS NULL OR tanggal <= $2)", [f, t])).rows[0];
  return {
    period: { from: f, to: t }, stock,
    sales: {
      ...sum(rows), tanpaSurat: rows.filter((r) => r.tanpaSurat).length, dihargai: rows.filter((r) => r.harga > 0).length, terjual: sum(rows.filter((r) => r.status === 'terjual')), dipesan: sum(rows.filter((r) => r.status === 'dipesan')),
      byType: group((r) => r.type || '—').sort((a, b) => a.key.localeCompare(b.key)),
      byCara: group((r) => r.cara).sort((a, b) => b.nilai - a.nilai),
      byMonth: group((r) => (r.tanggal || '').slice(0, 7) || '—').sort((a, b) => a.key.localeCompare(b.key)),
      bySales: group((r) => r.sales).sort((a, b) => b.nilai - a.nilai || b.jumlah - a.jumlah),
    },
    receipts: { jumlah: rec.n, total: Number(rec.total) },
    rows,
  };
}

// ───────── payments / receivables ─────────
// Per unit that is reserved or sold and has an SKU/SPU: the schedule of that letter against the unit's receipts.
// Receipts are the kwitansi documents of the unit, so a corrected receipt corrects the receivables as well.
async function tagihanList() {
  const Schedule = require('../lib/schedule'), payments = require('../lib/payments');
  const today = numbering.todayISO();
  const letters = (await db.query(
    `SELECT DISTINCT ON (lower(d.no_unit)) d.id, d.no, d.jenis, d.nama, d.no_unit, d.tanggal, d.data, u.type, u.status
     FROM documents d JOIN units u ON lower(u.no_unit) = lower(d.no_unit) AND u.status <> 'tersedia'
     WHERE d.jenis IN ('surat-konfirmasi', 'surat-pemesanan') AND d.no_unit <> '' AND d.id > ${CUT('d')}
     ORDER BY lower(d.no_unit), d.id DESC`)).rows;
  const receipts = new Map();
  for (const k of (await db.query(`SELECT d.no, d.no_unit, d.tanggal, d.jumlah, d.data FROM documents d WHERE d.jenis = 'kwitansi' AND d.no_unit <> '' AND d.id > ${CUT('d')} ORDER BY d.id`)).rows) {
    const key = k.no_unit.toLowerCase();
    if (!receipts.has(key)) receipts.set(key, []);
    receipts.get(key).push({ key: payments.keyOfReceipt(k.data), jumlah: k.jumlah, tanggal: k.tanggal || '', no: k.no });
  }
  const units = letters.map((l) => {
    const rows = Schedule.rows(l.data, { reservasi: l.jenis === 'surat-konfirmasi' });
    const a = payments.allocate(rows, receipts.get(l.no_unit.toLowerCase()) || [], today);
    return {
      unit: l.no_unit, type: l.type || '', status: l.status, pemesan: l.nama || '', surat: { id: l.id, no: l.no, jenis: l.jenis, tanggal: l.tanggal },
      cara: CARA_LABEL[l.data && l.data.cara && l.data.cara.tipe] || '—', harga: Number(l.data && l.data.harga) || 0,
      tagihan: a.tagihan, dibayar: a.dibayar, lebih: a.lebih, sisa: a.sisa, telat: a.telat, hariTelat: a.hariTelat, denda: a.denda, lewatToleransi: a.lewatToleransi, persen: a.persen, next: a.next, rows: a.rows,
      telp: str(l.data && l.data.telp),
    };
  }).sort((x, y) => y.hariTelat - x.hariTelat || (x.next?.due || '9999').localeCompare(y.next?.due || '9999') || x.unit.localeCompare(y.unit, 'id', { numeric: true }));
  const sum = (f) => units.reduce((acc, u) => acc + f(u), 0);
  return {
    today, units,
    totals: { unit: units.length, tagihan: sum((u) => u.tagihan), dibayar: sum((u) => u.dibayar), sisa: sum((u) => u.sisa), telat: sum((u) => u.telat), denda: sum((u) => u.denda), unitTelat: units.filter((u) => u.hariTelat > 0).length, lunas: units.filter((u) => u.tagihan > 0 && u.sisa === 0).length },
  };
}

// Open schedule rows of a unit, for the receipt form (any signed-in user: they typed this schedule into the SKU/SPU).
async function jadwalUnit(noUnit) {
  const u = (await tagihanList()).units.find((x) => x.unit.toLowerCase() === str(noUnit).toLowerCase());
  if (!u) return null;
  return { unit: u.unit, pemesan: u.pemesan, rows: u.rows.filter((r) => r.sisa > 0).map((r) => ({ key: r.key, label: r.label, due: r.due, jumlah: r.jumlah, sisa: r.sisa, hariTelat: r.hariTelat })) };
}

// ───────── order cancellation ─────────
const CANCEL_REASONS = ['pembeli', 'bank', 'wanprestasi', 'lainnya'];
const cutoffOf = async (c, no) => Number((await c.query('SELECT COALESCE(max(doc_cutoff), 0) AS m FROM cancellations WHERE lower(no_unit) = lower($1)', [no])).rows[0].m);

// What was paid in the unit's current order, and what the terms suggest the company keeps for each reason:
// buyer's fault or default → booking fee + 50% of the down payments paid; bank refusal → booking fee only (S&K 6c/6d).
async function cancelPreview(noUnit, c = db) {
  const unit = (await c.query('SELECT * FROM units WHERE lower(no_unit) = lower($1)', [str(noUnit)])).rows[0];
  if (!unit) throw new HttpError(404, 'Unit tidak ditemukan.');
  if (unit.status === 'tersedia') throw new HttpError(409, 'Unit ini tidak sedang dipesan atau terjual.');
  const cut = await cutoffOf(c, unit.no_unit);
  const letter = (await c.query("SELECT id, no, nama, jenis FROM documents WHERE lower(no_unit) = lower($1) AND jenis IN ('surat-konfirmasi', 'surat-pemesanan') AND id > $2 ORDER BY id DESC LIMIT 1", [unit.no_unit, cut])).rows[0] || null;
  const parts = { reservasi: 0, booking: 0, uangMuka: 0, pelunasan: 0, lain: 0 };
  for (const k of (await c.query("SELECT jumlah, data FROM documents WHERE jenis = 'kwitansi' AND lower(no_unit) = lower($1) AND id > $2", [unit.no_unit, cut])).rows) {
    const u = k.data && k.data.untuk;
    parts[u === 'dp' ? 'uangMuka' : parts[u] !== undefined ? u : 'lain'] += Number(k.jumlah) || 0;
  }
  const dibayar = Object.values(parts).reduce((a, b) => a + b, 0);
  const cap = (n) => Math.max(0, Math.min(dibayar, Math.round(n)));
  return {
    unit: unit.no_unit, type: unit.type || '', status: unit.status, pemesan: (letter && letter.nama) || unit.pemesan || '', surat: letter && letter.no,
    dibayar, parts,
    saran: { pembeli: cap(parts.booking + parts.uangMuka * 0.5), wanprestasi: cap(parts.booking + parts.uangMuka * 0.5), bank: cap(parts.booking), lainnya: 0 },
  };
}

async function cancelOrder(f, user) {
  const alasan = str(f.alasan);
  if (!CANCEL_REASONS.includes(alasan)) throw new HttpError(422, 'Pilih alasan pembatalan.');
  return db.tx(async (c) => {
    const unit = await lockUnit(c, f.no_unit);
    if (!unit) throw new HttpError(404, 'Unit tidak ditemukan.');
    const pv = await cancelPreview(unit.no_unit, c);
    const hangus = f.hangus === undefined || f.hangus === '' ? pv.saran[alasan] : int(f.hangus);
    if (hangus == null || hangus < 0 || hangus > pv.dibayar) throw new HttpError(422, `Jumlah yang menjadi hak perusahaan harus antara 0 dan ${pv.dibayar}.`);
    const cutoff = Number((await c.query('SELECT COALESCE(max(id), 0) AS m FROM documents WHERE lower(no_unit) = lower($1)', [unit.no_unit])).rows[0].m);
    const kembali = pv.dibayar - hangus;
    const tanggal = isoDate(f.tanggal) || numbering.todayISO();
    const ins = await c.query(
      `INSERT INTO cancellations (no_unit, type, pemesan, surat_no, tanggal, alasan, catatan, dibayar, hangus, kembali, pengembalian, doc_cutoff, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [unit.no_unit, unit.type || '', pv.pemesan, pv.surat || '', tanggal, alasan, str(f.catatan).slice(0, 500), pv.dibayar, hangus, kembali, kembali > 0 ? 'menunggu' : 'tidak-ada', cutoff, user.id]);
    await c.query("UPDATE units SET status='tersedia', pemesan='', doc_no='', updated_by=$1, updated_at=now() WHERE id=$2", [user.id, unit.id]);
    await c.query('DELETE FROM handovers WHERE lower(no_unit) = lower($1)', [unit.no_unit]);
    for (const t of ['berkas_items', 'berkas_units', 'kpr_events']) await c.query(`DELETE FROM ${t} WHERE lower(no_unit) = lower($1)`, [unit.no_unit]); // the buyer's file goes with the order
    // the deal fell through: the prospect goes back to the pipeline as lost (their commission base is gone with the cycle)
    for (const pr of (await c.query("SELECT id FROM prospects WHERE lower(no_unit) = lower($1) FOR UPDATE", [unit.no_unit])).rows) {
      await c.query("UPDATE prospects SET no_unit = '', tahap = 'gagal', updated_at = now() WHERE id = $1", [pr.id]);
      await c.query("INSERT INTO prospect_notes (prospect_id, jenis, isi, tanggal, created_by) VALUES ($1,'catatan',$2,$3,$4)", [pr.id, `Pesanan unit ${unit.no_unit} dibatalkan.`, tanggal, user.id]);
    }
    await audit(c, user.id, 'order.cancel', 'unit', unit.id, { no_unit: unit.no_unit, alasan, dibayar: pv.dibayar, hangus, kembali });
    return { id: ins.rows[0].id, dibayar: pv.dibayar, hangus, kembali };
  });
}

const listCancellations = async () => (await db.query(
  `SELECT c.id, c.no_unit, c.type, c.pemesan, c.surat_no, c.tanggal, c.alasan, c.catatan, c.dibayar, c.hangus, c.kembali, c.pengembalian, c.pengembalian_tanggal, u.name AS created_by
   FROM cancellations c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.id DESC LIMIT 200`)).rows;

async function markRefund(id, f, user) {
  return db.tx(async (c) => {
    const r = (await c.query('SELECT * FROM cancellations WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new HttpError(404, 'Data pembatalan tidak ditemukan.');
    if (r.pengembalian !== 'menunggu') throw new HttpError(409, 'Pengembalian ini tidak sedang menunggu.');
    await c.query("UPDATE cancellations SET pengembalian = 'selesai', pengembalian_tanggal = $1 WHERE id = $2", [isoDate(f && f.tanggal) || numbering.todayISO(), id]);
    await audit(c, user.id, 'cancel.refund', 'unit', null, { no_unit: r.no_unit, kembali: r.kembali });
  });
}


// ───────── marketing: prospects, sales people, commission ─────────
const TAHAP = ['baru', 'dihubungi', 'survey', 'negosiasi', 'deal', 'gagal'];
const SUMBER = ['walk-in', 'instagram', 'facebook', 'whatsapp', 'website', 'referral', 'pameran', 'lainnya'];
const NOTE_JENIS = ['telepon', 'whatsapp', 'kunjungan', 'catatan'];
const SALES_TIPE = ['inhouse', 'freelance', 'agen'];
const pct = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null; };

const listSalesNames = async () => (await db.query('SELECT id, nama FROM sales_people WHERE aktif ORDER BY lower(nama)')).rows;

const PROSPECT_COLS = `p.id, p.nama, p.telp, p.email, p.sumber, p.minat_tipe, p.sales_id, s.nama AS sales, p.tahap, to_char(p.follow_up, 'YYYY-MM-DD') AS follow_up, p.catatan, p.no_unit,
  ${TS('p.created_at')} AS created_at, ${TS('p.updated_at')} AS updated_at`;

async function listProspects() {
  const rows = (await db.query(
    `SELECT ${PROSPECT_COLS},
       (SELECT jsonb_build_object('jenis', n.jenis, 'isi', n.isi, 'tanggal', to_char(n.tanggal, 'YYYY-MM-DD')) FROM prospect_notes n WHERE n.prospect_id = p.id ORDER BY n.id DESC LIMIT 1) AS terakhir
     FROM prospects p LEFT JOIN sales_people s ON s.id = p.sales_id ORDER BY p.id DESC LIMIT 1000`)).rows;
  const today = numbering.todayISO();
  const open = rows.filter((r) => !['deal', 'gagal'].includes(r.tahap));
  const month = today.slice(0, 7);
  const dealMonth = (await db.query("SELECT count(*)::int AS n FROM prospects WHERE tahap = 'deal' AND to_char(updated_at AT TIME ZONE $1, 'YYYY-MM') = $2", [require('./config').timezone, month])).rows[0].n;
  const deal = rows.filter((r) => r.tahap === 'deal').length, closed = deal + rows.filter((r) => r.tahap === 'gagal').length;
  return {
    today, prospects: rows,
    stats: {
      aktif: open.length,
      hariIni: open.filter((r) => r.follow_up === today).length,
      terlambat: open.filter((r) => r.follow_up && r.follow_up < today).length,
      dealBulanIni: dealMonth,
      konversi: closed ? Math.round((deal / closed) * 100) : 0,
      perTahap: Object.fromEntries(TAHAP.map((t) => [t, rows.filter((r) => r.tahap === t).length])),
    },
  };
}

function cleanProspect(f, partial) {
  const out = {};
  const put = (k, v) => { if (!partial || f[k] !== undefined) out[k] = v; };
  put('nama', str(f.nama).slice(0, 120)); put('telp', str(f.telp).slice(0, 30)); put('email', str(f.email).slice(0, 120));
  put('sumber', str(f.sumber) || 'lainnya'); put('minat_tipe', str(f.minat_tipe).slice(0, 40)); put('catatan', str(f.catatan).slice(0, 1000));
  put('follow_up', isoDate(f.follow_up)); put('sales_id', int(f.sales_id));
  if (!partial || f.tahap !== undefined) out.tahap = str(f.tahap) || 'baru';
  if (out.nama === '') throw new HttpError(422, 'Nama prospek wajib diisi.');
  if (out.sumber && !SUMBER.includes(out.sumber)) throw new HttpError(422, 'Sumber prospek tidak dikenal.');
  if (out.tahap && !TAHAP.includes(out.tahap)) throw new HttpError(422, 'Tahap tidak dikenal.');
  return out;
}
async function assertSales(c, id) {
  if (id == null) return;
  if (!(await c.query('SELECT 1 FROM sales_people WHERE id = $1', [id])).rowCount) throw new HttpError(422, 'Sales tidak ditemukan.');
}

async function createProspect(f, user) {
  const d = cleanProspect(f, false);
  if (d.tahap === 'deal') throw new HttpError(422, 'Prospek baru tidak bisa langsung deal; hubungkan ke unit setelah dibuat.');
  return db.tx(async (c) => {
    await assertSales(c, d.sales_id);
    const r = await c.query(
      `INSERT INTO prospects (nama, telp, email, sumber, minat_tipe, sales_id, tahap, follow_up, catatan, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [d.nama, d.telp, d.email, d.sumber, d.minat_tipe, d.sales_id, d.tahap, d.follow_up, d.catatan, user.id]);
    await audit(c, user.id, 'prospect.create', 'prospect', r.rows[0].id, { nama: d.nama });
    return { id: r.rows[0].id };
  });
}

async function updateProspect(id, f, user) {
  const d = cleanProspect(f, true);
  return db.tx(async (c) => {
    const old = (await c.query('SELECT * FROM prospects WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw new HttpError(404, 'Prospek tidak ditemukan.');
    if (old.tahap === 'deal' && d.tahap && d.tahap !== 'deal') throw new HttpError(409, 'Prospek ini sudah menjadi pemesan unit ' + old.no_unit + '. Batalkan pesanannya di menu Tagihan bila batal.');
    if (d.tahap === 'deal' && old.tahap !== 'deal') throw new HttpError(422, 'Untuk menjadikan deal, hubungkan prospek ke unit lewat tombol "Jadikan pemesan".');
    if (old.tahap === 'deal') delete d.tahap; // unchanged
    await assertSales(c, d.sales_id);
    const keys = Object.keys(d);
    if (!keys.length) return { id };
    // a deal's commission follows the sales person it was sold by: do not swap them silently
    if (old.tahap === 'deal' && 'sales_id' in d && d.sales_id !== old.sales_id) throw new HttpError(409, 'Sales pada prospek yang sudah deal tidak dapat diganti.');
    await c.query(`UPDATE prospects SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => d[k])]);
    if (d.tahap && d.tahap !== old.tahap) await audit(c, user.id, 'prospect.stage', 'prospect', id, { nama: old.nama, from: old.tahap, to: d.tahap });
    return { id };
  });
}

async function deleteProspect(id, user) {
  return db.tx(async (c) => {
    const old = (await c.query('SELECT nama, tahap, no_unit FROM prospects WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw new HttpError(404, 'Prospek tidak ditemukan.');
    if (old.no_unit) throw new HttpError(409, 'Prospek ini terhubung ke unit ' + old.no_unit + ' dan menjadi dasar komisi; tidak dapat dihapus.');
    await c.query('DELETE FROM prospects WHERE id = $1', [id]);
    await audit(c, user.id, 'prospect.delete', 'prospect', id, { nama: old.nama });
  });
}

async function listProspectNotes(id) {
  return (await db.query(
    `SELECT n.id, n.jenis, n.isi, to_char(n.tanggal, 'YYYY-MM-DD') AS tanggal, u.name AS oleh FROM prospect_notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.prospect_id = $1 ORDER BY n.tanggal DESC, n.id DESC`, [id])).rows;
}

async function addProspectNote(id, f, user) {
  const isi = str(f.isi).slice(0, 1000), jenis = str(f.jenis) || 'catatan';
  if (!isi) throw new HttpError(422, 'Isi catatan wajib diisi.');
  if (!NOTE_JENIS.includes(jenis)) throw new HttpError(422, 'Jenis catatan tidak dikenal.');
  return db.tx(async (c) => {
    const p = (await c.query('SELECT tahap FROM prospects WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) throw new HttpError(404, 'Prospek tidak ditemukan.');
    await c.query('INSERT INTO prospect_notes (prospect_id, jenis, isi, tanggal, created_by) VALUES ($1,$2,$3,$4,$5)', [id, jenis, isi, isoDate(f.tanggal) || numbering.todayISO(), user.id]);
    // contacting a brand-new prospect moves it forward; an optional next follow-up date replaces the old one
    const next = 'follow_up' in f ? isoDate(f.follow_up) : undefined;
    await c.query(`UPDATE prospects SET updated_at = now()${p.tahap === 'baru' ? ", tahap = 'dihubungi'" : ''}${next !== undefined ? ', follow_up = $2' : ''} WHERE id = $1`, next !== undefined ? [id, next] : [id]);
  });
}

// Turns a prospect into the buyer of a reserved/sold unit: that link is what the commission is calculated from.
async function convertProspect(id, f, user) {
  return db.tx(async (c) => {
    const p = (await c.query('SELECT * FROM prospects WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) throw new HttpError(404, 'Prospek tidak ditemukan.');
    if (p.tahap === 'deal') throw new HttpError(409, 'Prospek ini sudah terhubung ke unit ' + p.no_unit + '.');
    if (!p.sales_id) throw new HttpError(422, 'Pilih sales untuk prospek ini dulu; komisi dihitung dari sales yang menjualnya.');
    const unit = await lockUnit(c, f.no_unit);
    if (!unit) throw new HttpError(404, 'Unit tidak ditemukan.');
    if (unit.status === 'tersedia') throw new HttpError(409, `Unit ${unit.no_unit} masih tersedia. Buat Surat Konfirmasi atau Surat Pemesanan dulu agar unit tercatat dipesan.`);
    const taken = (await c.query("SELECT nama FROM prospects WHERE lower(no_unit) = lower($1)", [unit.no_unit])).rows[0];
    if (taken) throw new HttpError(409, `Unit ${unit.no_unit} sudah terhubung ke prospek ${taken.nama}.`);
    const s = (await c.query('SELECT rate FROM sales_people WHERE id = $1', [p.sales_id])).rows[0];
    const rate = 'rate' in f && str(f.rate) !== '' ? pct(f.rate) : Number(s.rate);
    if (rate == null) throw new HttpError(422, 'Persentase komisi harus 0–100.');
    await c.query("UPDATE prospects SET tahap = 'deal', no_unit = $2, komisi_rate = $3, updated_at = now() WHERE id = $1", [id, unit.no_unit, rate]);
    await c.query("INSERT INTO prospect_notes (prospect_id, jenis, isi, tanggal, created_by) VALUES ($1,'catatan',$2,$3,$4)", [id, `Menjadi pemesan unit ${unit.no_unit} (komisi ${rate}%).`, numbering.todayISO(), user.id]);
    await audit(c, user.id, 'prospect.convert', 'prospect', id, { nama: p.nama, no_unit: unit.no_unit, rate });
    return { no_unit: unit.no_unit, rate };
  });
}

// Admin: sales people.
const listSales = async () => (await db.query(`SELECT id, nama, telp, tipe, rate::float AS rate, aktif FROM sales_people ORDER BY aktif DESC, lower(nama)`)).rows;
function cleanSales(f, partial) {
  const out = {};
  if (!partial || f.nama !== undefined) out.nama = str(f.nama).slice(0, 80);
  if (!partial || f.telp !== undefined) out.telp = str(f.telp).slice(0, 30);
  if (!partial || f.tipe !== undefined) out.tipe = str(f.tipe) || 'inhouse';
  if (!partial || f.rate !== undefined) out.rate = pct(f.rate === undefined || str(f.rate) === '' ? 0 : f.rate);
  if (f.aktif !== undefined) out.aktif = !!f.aktif;
  if (out.nama === '') throw new HttpError(422, 'Nama sales wajib diisi.');
  if (out.tipe && !SALES_TIPE.includes(out.tipe)) throw new HttpError(422, 'Jenis sales tidak dikenal.');
  if ('rate' in out && out.rate == null) throw new HttpError(422, 'Persentase komisi harus 0–100.');
  return out;
}
const dupSales = (e) => { if (e.code === '23505') throw new HttpError(409, 'Nama sales itu sudah ada.'); throw e; };
async function createSales(f, user) {
  const d = cleanSales(f, false);
  return db.tx(async (c) => {
    const r = await c.query('INSERT INTO sales_people (nama, telp, tipe, rate) VALUES ($1,$2,$3,$4) RETURNING id', [d.nama, d.telp, d.tipe, d.rate]).catch(dupSales);
    await audit(c, user.id, 'sales.create', 'sales', r.rows[0].id, { nama: d.nama, rate: d.rate });
    return { id: r.rows[0].id };
  });
}
async function updateSales(id, f, user) {
  const d = cleanSales(f, true), keys = Object.keys(d);
  if (!keys.length) return { id };
  return db.tx(async (c) => {
    const r = await c.query(`UPDATE sales_people SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id`, [id, ...keys.map((k) => d[k])]).catch(dupSales);
    if (!r.rowCount) throw new HttpError(404, 'Sales tidak ditemukan.');
    await audit(c, user.id, 'sales.update', 'sales', id, d);
    return { id };
  });
}

// Admin: commission per sales person, from the money received on the units they sold.
async function komisi() {
  const komisiLib = require('../lib/komisi');
  const pt = await tagihanList();
  const byUnit = new Map(pt.units.map((u) => [u.unit.toLowerCase(), u]));
  const people = await listSales();
  const deals = (await db.query("SELECT id, nama, sales_id, no_unit, komisi_rate::float AS rate FROM prospects WHERE tahap = 'deal' AND no_unit <> '' AND sales_id IS NOT NULL ORDER BY id")).rows
    .map((d) => { const u = byUnit.get(d.no_unit.toLowerCase()); return { ...d, dibayar: u ? u.dibayar : 0, tagihan: u ? u.tagihan : 0, status: u ? u.status : '' }; });
  const payouts = (await db.query(
    `SELECT p.id, p.sales_id, p.no_unit, p.jumlah::float AS jumlah, to_char(p.tanggal, 'YYYY-MM-DD') AS tanggal, p.catatan, u.name AS oleh FROM commission_payouts p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.tanggal DESC, p.id DESC LIMIT 500`)).rows;
  const sum = komisiLib.ringkas(deals, payouts);
  const rows = people.map((s) => ({
    ...s, ...(sum.get(s.id) || { unit: 0, dasar: 0, hak: 0, sudah: 0, sisa: 0 }),
    deals: deals.filter((d) => d.sales_id === s.id).map((d) => ({ ...d, ...komisiLib.hakKomisi(d.rate, d.dibayar, d.tagihan) })),
    payouts: payouts.filter((p) => p.sales_id === s.id),
  }));
  const t = (k) => rows.reduce((a, r) => a + r[k], 0);
  return { today: pt.today, sales: rows, totals: { hak: t('hak'), sudah: t('sudah'), sisa: t('sisa'), unit: t('unit') } };
}

async function addPayout(f, user) {
  const jumlah = int(f.jumlah), salesId = int(f.sales_id);
  if (!jumlah || jumlah <= 0) throw new HttpError(422, 'Jumlah pencairan harus lebih dari 0.');
  return db.tx(async (c) => {
    const s = (await c.query('SELECT nama FROM sales_people WHERE id = $1', [salesId])).rows[0];
    if (!s) throw new HttpError(404, 'Sales tidak ditemukan.');
    const r = await c.query('INSERT INTO commission_payouts (sales_id, no_unit, jumlah, tanggal, catatan, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [salesId, str(f.no_unit).slice(0, 30), jumlah, isoDate(f.tanggal) || numbering.todayISO(), str(f.catatan).slice(0, 300), user.id]);
    await audit(c, user.id, 'komisi.payout', 'sales', salesId, { nama: s.nama, jumlah, no_unit: str(f.no_unit) });
    return { id: r.rows[0].id };
  });
}
async function deletePayout(id, user) {
  return db.tx(async (c) => {
    const r = (await c.query('DELETE FROM commission_payouts WHERE id = $1 RETURNING sales_id, jumlah', [id])).rows[0];
    if (!r) throw new HttpError(404, 'Pencairan tidak ditemukan.');
    await audit(c, user.id, 'komisi.payout.delete', 'sales', r.sales_id, { jumlah: Number(r.jumlah) });
  });
}


// ───────── buyer files and KPR ─────────
// Units with a running order; the checklist depends on the payment method of the latest SKU/SPU.
async function berkasUnits(only) {
  const berkas = require('../lib/berkas'), today = numbering.todayISO();
  const units = (await db.query(
    `SELECT u.no_unit, u.type, u.status, u.pemesan, l.nama, l.cara
     FROM units u LEFT JOIN LATERAL (SELECT d.nama, d.data #>> '{cara,tipe}' AS cara FROM documents d
        WHERE lower(d.no_unit) = lower(u.no_unit) AND d.jenis IN ('surat-konfirmasi', 'surat-pemesanan') AND d.id > ${CUT('d')} ORDER BY d.id DESC LIMIT 1) l ON TRUE
     WHERE u.status <> 'tersedia'${only ? ' AND lower(u.no_unit) = lower($1)' : ''}`, only ? [only] : [])).rows;
  const items = new Map(), info = new Map();
  for (const r of (await db.query("SELECT no_unit, kode, selesai, to_char(tanggal, 'YYYY-MM-DD') AS tanggal, catatan FROM berkas_items")).rows) {
    const k = r.no_unit.toLowerCase(); if (!items.has(k)) items.set(k, new Map()); items.get(k).set(r.kode, r);
  }
  for (const r of (await db.query("SELECT no_unit, bank, kpr_tahap, to_char(tenggat, 'YYYY-MM-DD') AS tenggat, tenggat_ket, catatan FROM berkas_units")).rows) info.set(r.no_unit.toLowerCase(), r);
  const out = units.map((u) => {
    const k = u.no_unit.toLowerCase(), got = items.get(k) || new Map(), i = info.get(k) || {};
    const list = berkas.checklist(u.cara).map((it) => ({ ...it, selesai: !!(got.get(it.kode) || {}).selesai, tanggal: (got.get(it.kode) || {}).tanggal || '', catatan: (got.get(it.kode) || {}).catatan || '' }));
    const kpr = u.cara === 'kpr';
    const tahap = kpr ? i.kpr_tahap || 'berkas' : '';
    return {
      unit: u.no_unit, type: u.type || '', status: u.status, pemesan: u.nama || u.pemesan || '', cara: u.cara || '', caraLabel: CARA_LABEL[u.cara] || '—',
      items: list, done: list.filter((x) => x.selesai).length, total: list.length,
      bank: kpr ? i.bank || '' : '', tahap, tahapLabel: kpr ? berkas.KPR_LABEL[tahap] : '', tenggat: i.tenggat || '', tenggatKet: i.tenggat_ket || '', catatan: i.catatan || '',
      telat: berkas.isLate(i.tenggat, tahap, today),
    };
  });
  return { today, units: out };
}

async function berkasList() {
  const { today, units } = await berkasUnits();
  units.sort((a, b) => (b.telat - a.telat) || (a.tenggat || '9999').localeCompare(b.tenggat || '9999') || a.unit.localeCompare(b.unit, 'id', { numeric: true }));
  const kpr = units.filter((u) => u.cara === 'kpr');
  return {
    today, units,
    stats: {
      unit: units.length, belumLengkap: units.filter((u) => u.done < u.total).length, telat: units.filter((u) => u.telat).length,
      kpr: kpr.length, kprBerjalan: kpr.filter((u) => !['cair', 'ditolak'].includes(u.tahap)).length, ditolak: kpr.filter((u) => u.tahap === 'ditolak').length, cair: kpr.filter((u) => u.tahap === 'cair').length,
      perTahap: Object.fromEntries(require('../lib/berkas').KPR_TAHAP.map((t) => [t, kpr.filter((u) => u.tahap === t).length])),
    },
  };
}

const berkasUnit = async (no) => {
  const u = (await berkasUnits(str(no))).units[0];
  if (!u) throw new HttpError(404, 'Unit ini tidak sedang dipesan atau terjual.');
  return u;
};

async function setBerkasItem(no, f, user) {
  const u = await berkasUnit(no), it = u.items.find((x) => x.kode === str(f.kode));
  if (!it) throw new HttpError(422, 'Item berkas tidak dikenal untuk unit ini.');
  const selesai = !!f.selesai, tanggal = selesai ? isoDate(f.tanggal) || numbering.todayISO() : null;
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO berkas_items (no_unit, kode, selesai, tanggal, catatan, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (no_unit, kode) DO UPDATE SET selesai = $3, tanggal = $4, catatan = $5, updated_by = $6, updated_at = now()`,
      [u.unit, it.kode, selesai, tanggal, f.catatan === undefined ? it.catatan : str(f.catatan).slice(0, 300), user.id]);
    await audit(c, user.id, 'berkas.item', 'unit', null, { no_unit: u.unit, kode: it.kode, selesai });
  });
}

async function setBerkasInfo(no, f, user) {
  const berkas = require('../lib/berkas'), u = await berkasUnit(no);
  const tahap = f.tahap === undefined ? undefined : str(f.tahap);
  if (tahap !== undefined && u.cara !== 'kpr') throw new HttpError(422, 'Tahap bank hanya untuk pembelian KPR.');
  if (tahap !== undefined && !berkas.KPR_TAHAP.includes(tahap)) throw new HttpError(422, 'Tahap bank tidak dikenal.');
  if (f.bank !== undefined && u.cara !== 'kpr') throw new HttpError(422, 'Bank hanya untuk pembelian KPR.');
  await db.tx(async (c) => {
    const old = (await c.query('SELECT * FROM berkas_units WHERE no_unit = $1 FOR UPDATE', [u.unit])).rows[0] || { bank: '', kpr_tahap: 'berkas', tenggat: null, tenggat_ket: '', catatan: '' };
    const next = {
      bank: f.bank === undefined ? old.bank : str(f.bank).slice(0, 80),
      kpr_tahap: tahap === undefined ? old.kpr_tahap : tahap,
      tenggat: f.tenggat === undefined ? u.tenggat || null : isoDate(f.tenggat),
      tenggat_ket: f.tenggat_ket === undefined ? old.tenggat_ket : str(f.tenggat_ket).slice(0, 120),
      catatan: f.catatan === undefined ? old.catatan : str(f.catatan).slice(0, 500),
    };
    await c.query(
      `INSERT INTO berkas_units (no_unit, bank, kpr_tahap, tenggat, tenggat_ket, catatan, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (no_unit) DO UPDATE SET bank = $2, kpr_tahap = $3, tenggat = $4, tenggat_ket = $5, catatan = $6, updated_by = $7, updated_at = now()`,
      [u.unit, next.bank, next.kpr_tahap, next.tenggat, next.tenggat_ket, next.catatan, user.id]);
    if (u.cara === 'kpr' && next.kpr_tahap !== old.kpr_tahap) {
      await c.query('INSERT INTO kpr_events (no_unit, tahap, tanggal, catatan, created_by) VALUES ($1,$2,$3,$4,$5)', [u.unit, next.kpr_tahap, isoDate(f.tanggal) || numbering.todayISO(), str(f.catatan_tahap).slice(0, 300), user.id]);
      await audit(c, user.id, 'kpr.stage', 'unit', null, { no_unit: u.unit, from: old.kpr_tahap, to: next.kpr_tahap, bank: next.bank });
    }
  });
}

async function kprEvents(no) {
  return (await db.query(
    `SELECT e.id, e.tahap, to_char(e.tanggal, 'YYYY-MM-DD') AS tanggal, e.catatan, u.name AS oleh FROM kpr_events e LEFT JOIN users u ON u.id = e.created_by WHERE lower(e.no_unit) = lower($1) ORDER BY e.tanggal DESC, e.id DESC`, [str(no)])).rows;
}


// ───────── construction progress, punch list, handover ─────────
const MAX_FOTO_PER_UNIT = 80;
const unitRow = async (c, no) => {
  const u = (await c.query('SELECT * FROM units WHERE lower(no_unit) = lower($1)', [str(no)])).rows[0];
  if (!u) throw new HttpError(404, 'Unit tidak ditemukan.');
  return u;
};

// Everything about handover that can be told from the money side: paid in full? reference date for the 12 months?
async function serahBasis() {
  const out = new Map();
  for (const u of (await tagihanList()).units) {
    const dates = u.rows.flatMap((r) => r.kwitansi.map((k) => k.tanggal)).filter(Boolean).sort();
    const first = (u.rows.find((r) => r.key === 'cicilan1') || { kwitansi: [] }).kwitansi.map((k) => k.tanggal).filter(Boolean).sort()[0] || '';
    const lunas = u.tagihan > 0 && u.sisa === 0;
    out.set(u.unit.toLowerCase(), { lunas, acuan: lunas ? dates[dates.length - 1] || '' : first });
  }
  return out;
}

async function progresList(user) {
  const P = require('../lib/progres'), today = numbering.todayISO(), admin = user && user.role === 'admin';
  const units = (await db.query('SELECT no_unit, type, status, pemesan FROM units ORDER BY no_unit')).rows;
  const stages = new Map(), foto = new Map(), punch = new Map(), hand = new Map();
  for (const r of (await db.query('SELECT no_unit, kode, persen, catatan FROM progres_units')).rows) { const k = r.no_unit.toLowerCase(); if (!stages.has(k)) stages.set(k, {}); stages.get(k)[r.kode] = { persen: r.persen, catatan: r.catatan }; }
  for (const r of (await db.query('SELECT lower(no_unit) AS k, count(*)::int AS n FROM progres_foto GROUP BY 1')).rows) foto.set(r.k, r.n);
  for (const r of (await db.query("SELECT lower(no_unit) AS k, count(*)::int AS total, count(*) FILTER (WHERE status = 'open')::int AS open FROM punch_items GROUP BY 1")).rows) punch.set(r.k, r);
  for (const r of (await db.query("SELECT no_unit, no_bast, to_char(tanggal, 'YYYY-MM-DD') AS tanggal, penerima, catatan, to_char(tanggal_acuan, 'YYYY-MM-DD') AS acuan, sisa_pekerjaan::float AS sisa, dipaksa FROM handovers")).rows) hand.set(r.no_unit.toLowerCase(), r);
  const basis = await serahBasis();
  const rows = units.map((u) => {
    const k = u.no_unit.toLowerCase(), st = stages.get(k) || {}, h = hand.get(k) || null, b = basis.get(k) || { lunas: false, acuan: '' };
    const acuan = (h && h.acuan) || b.acuan, js = P.jadwalSerah(acuan, today), pc = punch.get(k) || { total: 0, open: 0 };
    const row = {
      unit: u.no_unit, type: u.type || '', status: u.status, pemesan: u.pemesan || '',
      progres: P.overall(Object.fromEntries(Object.entries(st).map(([c, v]) => [c, v.persen]))), foto: foto.get(k) || 0,
      punch: pc, lunas: b.lunas, acuan, target: js.target, batas: js.batas, hariTelat: h ? 0 : js.hariTelat,
      serah: h ? { no: h.no_bast, tanggal: h.tanggal, penerima: h.penerima } : null,
      siap: !h && u.status !== 'tersedia' && b.lunas,
    };
    return row;
  });
  return { today, stages: P.STAGES, units: rows, admin: !!admin,
    stats: { unit: rows.length, rata: rows.length ? Math.round(rows.reduce((a, r) => a + r.progres, 0) / rows.length) : 0, selesai: rows.filter((r) => r.progres === 100).length,
      siap: rows.filter((r) => r.siap).length, diserahkan: rows.filter((r) => r.serah).length, punchOpen: rows.reduce((a, r) => a + r.punch.open, 0), telat: rows.filter((r) => r.hariTelat > 0).length } };
}

async function progresUnit(no, user) {
  const P = require('../lib/progres'), list = await progresList(user);
  const row = list.units.find((u) => u.unit.toLowerCase() === str(no).toLowerCase());
  if (!row) throw new HttpError(404, 'Unit tidak ditemukan.');
  const k = row.unit;
  const st = {};
  for (const r of (await db.query('SELECT kode, persen, catatan FROM progres_units WHERE lower(no_unit) = lower($1)', [k])).rows) st[r.kode] = r;
  const fotos = (await db.query(`SELECT f.id, f.kode, to_char(f.tanggal, 'YYYY-MM-DD') AS tanggal, f.keterangan, f.filename, u.name AS oleh FROM progres_foto f LEFT JOIN users u ON u.id = f.user_id WHERE lower(f.no_unit) = lower($1) ORDER BY f.tanggal DESC, f.created_at DESC`, [k])).rows;
  const punch = (await db.query("SELECT id, ruang, uraian, status, to_char(selesai_tanggal, 'YYYY-MM-DD') AS selesai_tanggal FROM punch_items WHERE lower(no_unit) = lower($1) ORDER BY status DESC, id", [k])).rows;
  const hand = (await db.query("SELECT no_bast, to_char(tanggal, 'YYYY-MM-DD') AS tanggal, penerima, catatan, sisa_pekerjaan::float AS sisa, dipaksa FROM handovers WHERE lower(no_unit) = lower($1)", [k])).rows[0] || null;
  const out = { ...row, tahap: P.STAGES.map((s) => ({ ...s, persen: (st[s.kode] || {}).persen || 0, catatan: (st[s.kode] || {}).catatan || '' })), fotos, punchItems: punch, serahDetail: hand && { ...hand, sisa: user.role === 'admin' ? hand.sisa : undefined } };
  return out;
}

async function setProgres(no, f, user) {
  const P = require('../lib/progres'), stage = P.STAGES.find((s) => s.kode === str(f.kode));
  if (!stage) throw new HttpError(422, 'Tahap pekerjaan tidak dikenal.');
  const persen = int(f.persen);
  if (persen == null || persen < 0 || persen > 100) throw new HttpError(422, 'Persentase harus 0–100.');
  return db.tx(async (c) => {
    const u = await unitRow(c, no);
    const old = (await c.query('SELECT persen FROM progres_units WHERE no_unit = $1 AND kode = $2', [u.no_unit, stage.kode])).rows[0];
    await c.query(
      `INSERT INTO progres_units (no_unit, kode, persen, catatan, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (no_unit, kode) DO UPDATE SET persen = $3, catatan = CASE WHEN $6 THEN $4 ELSE progres_units.catatan END, updated_by = $5, updated_at = now()`,
      [u.no_unit, stage.kode, persen, str(f.catatan).slice(0, 300), user.id, f.catatan !== undefined]);
    if (!old || old.persen !== persen) await audit(c, user.id, 'progres.update', 'unit', u.id, { no_unit: u.no_unit, kode: stage.kode, from: old ? old.persen : 0, to: persen });
  });
}

async function addFoto({ no, kode, keterangan, tanggal, filename, mime, data, user }) {
  const P = require('../lib/progres');
  if (kode && !P.STAGES.some((s) => s.kode === kode)) throw new HttpError(422, 'Tahap pekerjaan tidak dikenal.');
  return db.tx(async (c) => {
    const u = await unitRow(c, no);
    if ((await c.query('SELECT count(*)::int AS n FROM progres_foto WHERE lower(no_unit) = lower($1)', [u.no_unit])).rows[0].n >= MAX_FOTO_PER_UNIT) throw new HttpError(409, `Maksimal ${MAX_FOTO_PER_UNIT} foto per unit. Hapus yang tidak perlu dulu.`);
    const r = await c.query('INSERT INTO progres_foto (no_unit, kode, tanggal, keterangan, filename, mime, size, data, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [u.no_unit, kode || '', isoDate(tanggal) || numbering.todayISO(), str(keterangan).slice(0, 200), filename, mime, data.length, data, user.id]);
    await audit(c, user.id, 'progres.foto', 'unit', u.id, { no_unit: u.no_unit, kode: kode || '' });
    return { id: r.rows[0].id };
  });
}
const getFoto = async (id) => (/^[0-9a-f-]{36}$/i.test(str(id)) ? (await db.query('SELECT filename, mime, data FROM progres_foto WHERE id = $1', [id])).rows[0] || null : null);
async function deleteFoto(id, user) {
  return db.tx(async (c) => {
    const r = (await c.query('SELECT user_id, no_unit FROM progres_foto WHERE id::text = $1 FOR UPDATE', [str(id)])).rows[0];
    if (!r) throw new HttpError(404, 'Foto tidak ditemukan.');
    if (user.role !== 'admin' && r.user_id !== user.id) throw new HttpError(403, 'Hanya pengunggah atau admin yang dapat menghapus foto ini.');
    await c.query('DELETE FROM progres_foto WHERE id::text = $1', [str(id)]);
    await audit(c, user.id, 'progres.foto.delete', 'unit', null, { no_unit: r.no_unit });
  });
}

async function addPunch(no, f, user) {
  const uraian = str(f.uraian).slice(0, 300);
  if (!uraian) throw new HttpError(422, 'Uraian pekerjaan wajib diisi.');
  return db.tx(async (c) => {
    const u = await unitRow(c, no);
    if ((await c.query('SELECT 1 FROM handovers WHERE lower(no_unit) = lower($1)', [u.no_unit])).rowCount) throw new HttpError(409, 'Unit ini sudah diserahterimakan; temuan baru dicatat di luar sistem.');
    const r = await c.query('INSERT INTO punch_items (no_unit, ruang, uraian, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [u.no_unit, str(f.ruang).slice(0, 60), uraian, user.id]);
    await audit(c, user.id, 'punch.add', 'unit', u.id, { no_unit: u.no_unit, uraian });
    return { id: r.rows[0].id };
  });
}
async function setPunch(id, f, user) {
  return db.tx(async (c) => {
    const r = (await c.query('SELECT * FROM punch_items WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new HttpError(404, 'Item tidak ditemukan.');
    const status = f.status === undefined ? r.status : str(f.status);
    if (!['open', 'selesai'].includes(status)) throw new HttpError(422, 'Status tidak dikenal.');
    await c.query('UPDATE punch_items SET status = $2, selesai_tanggal = $3 WHERE id = $1', [id, status, status === 'selesai' ? numbering.todayISO() : null]);
    if (status !== r.status) await audit(c, user.id, 'punch.status', 'unit', null, { no_unit: r.no_unit, uraian: r.uraian, to: status });
  });
}
async function deletePunch(id, user) {
  return db.tx(async (c) => {
    const r = (await c.query('DELETE FROM punch_items WHERE id = $1 RETURNING no_unit, uraian', [id])).rows[0];
    if (!r) throw new HttpError(404, 'Item tidak ditemukan.');
    await audit(c, user.id, 'punch.delete', 'unit', null, { no_unit: r.no_unit, uraian: r.uraian });
  });
}

const romanMonth = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
async function createHandover(no, f, user) {
  const penerima = str(f.penerima).slice(0, 120);
  if (!penerima) throw new HttpError(422, 'Nama penerima wajib diisi.');
  const tanggal = isoDate(f.tanggal) || numbering.todayISO(), paksa = !!f.paksa && user.role === 'admin';
  const basis = await serahBasis();
  return db.tx(async (c) => {
    const u = await unitRow(c, no);
    await c.query('SELECT 1 FROM units WHERE id = $1 FOR UPDATE', [u.id]);
    if (u.status === 'tersedia') throw new HttpError(409, 'Unit ini belum dipesan; tidak ada yang menerima serah terima.');
    if ((await c.query('SELECT 1 FROM handovers WHERE lower(no_unit) = lower($1)', [u.no_unit])).rowCount) throw new HttpError(409, 'Unit ini sudah diserahterimakan.');
    const b = basis.get(u.no_unit.toLowerCase()) || { lunas: false, acuan: '' };
    const open = (await c.query("SELECT ruang, uraian FROM punch_items WHERE lower(no_unit) = lower($1) AND status = 'open' ORDER BY id", [u.no_unit])).rows;
    if (!b.lunas && !paksa) throw new HttpError(409, 'Serah terima baru dapat dilakukan setelah pemesan melunasi seluruh kewajiban pembayaran (S&K).');
    if (open.length && !paksa) throw new HttpError(409, `Masih ada ${open.length} pekerjaan yang belum selesai di daftar periksa. Selesaikan dulu, atau admin dapat menyerahkan dengan catatan.`);
    const year = tanggal.slice(0, 4), month = romanMonth[+tanggal.slice(5, 7) - 1];
    const n = (await c.query("INSERT INTO counters (name, last) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET last = counters.last + 1 RETURNING last", [`bast-${year}`])).rows[0].last;
    const noBast = `${String(n).padStart(3, '0')}/BAST/SL-BSS/${month}/${year}`;
    await c.query('INSERT INTO handovers (no_unit, no_bast, tanggal, penerima, catatan, tanggal_acuan, sisa_pekerjaan, dipaksa, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [u.no_unit, noBast, tanggal, penerima, str(f.catatan).slice(0, 500), b.acuan || null, user.role === 'admin' ? Math.max(0, int(f.sisa_pekerjaan) || 0) : 0, paksa && (!b.lunas || open.length > 0), user.id]);
    await audit(c, user.id, 'serah.create', 'unit', u.id, { no_unit: u.no_unit, no: noBast, penerima, dipaksa: paksa && (!b.lunas || open.length > 0) });
    return { no: noBast };
  });
}

async function bastData(no) {
  const h = (await db.query("SELECT h.no_unit, h.no_bast, to_char(h.tanggal, 'YYYY-MM-DD') AS tanggal, h.penerima, h.catatan, u.type FROM handovers h LEFT JOIN units u ON lower(u.no_unit) = lower(h.no_unit) WHERE lower(h.no_unit) = lower($1)", [str(no)])).rows[0];
  if (!h) throw new HttpError(404, 'Belum ada serah terima untuk unit ini.');
  const open = (await db.query("SELECT ruang, uraian FROM punch_items WHERE lower(no_unit) = lower($1) AND status = 'open' ORDER BY id", [h.no_unit])).rows;
  const b = (await serahBasis()).get(h.no_unit.toLowerCase());
  return { lunas: !!(b && b.lunas), no: h.no_bast, tanggal: h.tanggal, penerima: h.penerima, noUnit: h.no_unit, type: h.type || '', catatan: h.catatan, sisa: open.map((o) => (o.ruang ? o.ruang + ': ' : '') + o.uraian) };
}


// ───────── warehouse and materials ─────────
const G = () => require('../lib/gudang');
const round3 = (n) => Math.round(n * 1000) / 1000;

async function gudangList(user) {
  const admin = user && user.role === 'admin';
  const lokasi = (await db.query('SELECT id, nama, aktif FROM gudang ORDER BY aktif DESC, lower(nama)')).rows;
  const per = new Map();
  for (const r of (await db.query('SELECT material_id, gudang_id, sum(qty)::float AS qty FROM stok_mutasi GROUP BY 1, 2')).rows) {
    if (!per.has(r.material_id)) per.set(r.material_id, {}); per.get(r.material_id)[r.gudang_id] = round3(r.qty);
  }
  const material = (await db.query('SELECT id, kode, nama, satuan, minimum::float AS minimum, aktif, stok_total::float AS stok, nilai_total::float AS nilai FROM material ORDER BY aktif DESC, lower(nama)')).rows.map((m) => ({
    id: m.id, kode: m.kode, nama: m.nama, satuan: m.satuan, minimum: m.minimum, aktif: m.aktif, stok: round3(m.stok), perGudang: per.get(m.id) || {},
    bawah: m.aktif && m.minimum > 0 && m.stok <= m.minimum, ...(admin ? { nilai: m.nilai, rata: m.stok > 0 ? Math.round(m.nilai / m.stok) : 0 } : {}),
  }));
  return { admin: !!admin, today: numbering.todayISO(), gudang: lokasi, material,
    stats: { material: material.filter((m) => m.aktif).length, bawah: material.filter((m) => m.bawah).length, kosong: material.filter((m) => m.aktif && m.stok === 0).length, ...(admin ? { nilai: material.reduce((a, m) => a + m.nilai, 0) } : {}) } };
}

const cleanMaterial = (f, partial) => {
  const out = {}, g = G();
  if (!partial || f.kode !== undefined) out.kode = str(f.kode).slice(0, 30);
  if (!partial || f.nama !== undefined) out.nama = str(f.nama).slice(0, 120);
  if (!partial || f.satuan !== undefined) out.satuan = str(f.satuan).slice(0, 20);
  if (!partial || f.minimum !== undefined) out.minimum = str(f.minimum) === '' ? 0 : g.qty3(f.minimum);
  if (f.aktif !== undefined) out.aktif = !!f.aktif;
  if ('kode' in out && !out.kode) throw new HttpError(422, 'Kode material wajib diisi.');
  if ('nama' in out && !out.nama) throw new HttpError(422, 'Nama material wajib diisi.');
  if ('satuan' in out && !out.satuan) throw new HttpError(422, 'Satuan wajib diisi (sak, m3, batang…).');
  if ('minimum' in out && !(out.minimum >= 0)) throw new HttpError(422, 'Stok minimum tidak valid.');
  return out;
};
const dupMsg = (what) => (e) => { if (e.code === '23505') throw new HttpError(409, `${what} itu sudah ada.`); throw e; };
async function createMaterial(f, user) {
  const d = cleanMaterial(f, false);
  return db.tx(async (c) => {
    const r = await c.query('INSERT INTO material (kode, nama, satuan, minimum) VALUES ($1,$2,$3,$4) RETURNING id', [d.kode, d.nama, d.satuan, d.minimum]).catch(dupMsg('Kode material'));
    await audit(c, user.id, 'material.create', 'material', r.rows[0].id, { kode: d.kode, nama: d.nama });
    return { id: r.rows[0].id };
  });
}
async function updateMaterial(id, f, user) {
  const d = cleanMaterial(f, true), keys = Object.keys(d);
  if (!keys.length) return { id };
  return db.tx(async (c) => {
    const r = await c.query(`UPDATE material SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING kode`, [id, ...keys.map((k) => d[k])]).catch(dupMsg('Kode material'));
    if (!r.rowCount) throw new HttpError(404, 'Material tidak ditemukan.');
    await audit(c, user.id, 'material.update', 'material', id, { kode: r.rows[0].kode, ...d });
    return { id };
  });
}
async function saveGudang(id, f, user) {
  const nama = f.nama === undefined ? undefined : str(f.nama).slice(0, 60);
  if (nama === '') throw new HttpError(422, 'Nama gudang wajib diisi.');
  return db.tx(async (c) => {
    if (id == null) {
      if (!nama) throw new HttpError(422, 'Nama gudang wajib diisi.');
      const r = await c.query('INSERT INTO gudang (nama) VALUES ($1) RETURNING id', [nama]).catch(dupMsg('Nama gudang'));
      await audit(c, user.id, 'gudang.create', 'gudang', r.rows[0].id, { nama }); return { id: r.rows[0].id };
    }
    const old = (await c.query('SELECT * FROM gudang WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!old) throw new HttpError(404, 'Gudang tidak ditemukan.');
    if (f.aktif === false && (await c.query('SELECT 1 FROM stok_mutasi WHERE gudang_id = $1 GROUP BY material_id HAVING sum(qty) <> 0 LIMIT 1', [id])).rowCount) throw new HttpError(409, 'Gudang ini masih berisi stok; pindahkan dulu.');
    if (f.aktif === false && (await c.query('SELECT count(*)::int AS n FROM gudang WHERE aktif AND id <> $1', [id])).rows[0].n === 0) throw new HttpError(409, 'Harus ada minimal satu gudang aktif.');
    await c.query('UPDATE gudang SET nama = COALESCE($2, nama), aktif = COALESCE($3, aktif) WHERE id = $1', [id, nama ?? null, f.aktif === undefined ? null : !!f.aktif]).catch(dupMsg('Nama gudang'));
    await audit(c, user.id, 'gudang.update', 'gudang', id, { nama: nama || old.nama, aktif: f.aktif }); return { id };
  });
}

const stockIn = async (c, materialId, gudangId) => Number((await c.query('SELECT COALESCE(sum(qty), 0)::float AS q FROM stok_mutasi WHERE material_id = $1 AND gudang_id = $2', [materialId, gudangId])).rows[0].q);
const lockGudang = async (c, id) => {
  const g = (await c.query('SELECT * FROM gudang WHERE id = $1', [int(id)])).rows[0];
  if (!g || !g.aktif) throw new HttpError(422, 'Gudang tidak ditemukan atau tidak aktif.');
  return g;
};

// masuk (receipt), keluar (issue, optionally to a unit), mutasi (transfer between warehouses), opname (counted stock).
async function gudangTransaksi(f, user) {
  const g = G(), jenis = str(f.jenis);
  if (!g.JENIS.includes(jenis)) throw new HttpError(422, 'Jenis transaksi tidak dikenal.');
  const qty = g.qty3(f.qty);
  if (!Number.isFinite(qty) || qty < 0 || (qty === 0 && jenis !== 'opname')) throw new HttpError(422, jenis === 'opname' ? 'Isi jumlah hasil hitung (0 atau lebih).' : 'Jumlah harus lebih dari 0.');
  const tanggal = isoDate(f.tanggal) || numbering.todayISO();
  const harga = str(f.harga) === '' ? null : Number(f.harga);
  if (harga != null && !(harga >= 0)) throw new HttpError(422, 'Harga satuan tidak valid.');
  const extra = { ref: str(f.ref).slice(0, 80), pihak: str(f.pihak).slice(0, 120), catatan: str(f.catatan).slice(0, 300) };
  return db.tx(async (c) => {
    const m = (await c.query('SELECT * FROM material WHERE id = $1 FOR UPDATE', [int(f.material_id)])).rows[0];
    if (!m) throw new HttpError(404, 'Material tidak ditemukan.');
    if (!m.aktif) throw new HttpError(409, 'Material ini nonaktif.');
    const gd = await lockGudang(c, f.gudang_id);
    const stok = Number(m.stok_total), nilai = Number(m.nilai_total), here = await stockIn(c, m.id, gd.id);
    const ins = (gudangId, q, v, no, grup) => c.query(
      'INSERT INTO stok_mutasi (tanggal, jenis, material_id, gudang_id, qty, nilai, no_unit, ref, pihak, catatan, grup, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
      [tanggal, jenis, m.id, gudangId, q, v, no || '', extra.ref, extra.pihak, extra.catatan, grup || null, user.id]);
    const totals = (dq, dv) => c.query('UPDATE material SET stok_total = stok_total + $2, nilai_total = nilai_total + $3 WHERE id = $1', [m.id, dq, dv]);
    const short = (have) => new HttpError(409, `Stok ${m.nama} di ${gd.nama} hanya ${have} ${m.satuan}.`);
    let id, v = 0;
    if (jenis === 'masuk') {
      v = g.nilaiMasuk(stok, nilai, qty, harga); id = (await ins(gd.id, qty, v)).rows[0].id; await totals(qty, v);
    } else if (jenis === 'keluar') {
      if (here < qty) throw short(here);
      let no = '';
      if (str(f.no_unit)) { const u = (await c.query('SELECT no_unit FROM units WHERE lower(no_unit) = lower($1)', [str(f.no_unit)])).rows[0]; if (!u) throw new HttpError(422, 'Unit tujuan tidak ditemukan.'); no = u.no_unit; }
      v = -g.biayaKeluar(stok, nilai, qty); id = (await ins(gd.id, -qty, v, no)).rows[0].id; await totals(-qty, v);
    } else if (jenis === 'mutasi') {
      const to = await lockGudang(c, f.ke_gudang_id);
      if (to.id === gd.id) throw new HttpError(422, 'Gudang asal dan tujuan sama.');
      if (here < qty) throw short(here);
      const grup = (await c.query('SELECT gen_random_uuid() AS g')).rows[0].g;
      id = (await ins(gd.id, -qty, 0, '', grup)).rows[0].id; await ins(to.id, qty, 0, '', grup);
    } else { // opname: qty is what was counted
      const delta = round3(qty - here);
      if (delta === 0) throw new HttpError(422, `Hasil hitung sama dengan stok di sistem (${here} ${m.satuan}).`);
      v = delta > 0 ? g.nilaiMasuk(stok, nilai, delta, null) : -g.biayaKeluar(stok, nilai, -delta);
      id = (await ins(gd.id, delta, v)).rows[0].id; await totals(delta, v);
    }
    await audit(c, user.id, 'gudang.' + jenis, 'material', m.id, { kode: m.kode, gudang: gd.nama, qty, no_unit: str(f.no_unit) });
    return { id };
  });
}

async function gudangRiwayat(q, user) {
  const admin = user.role === 'admin', args = [], where = [];
  if (int(q.material_id)) { args.push(int(q.material_id)); where.push(`s.material_id = $${args.length}`); }
  if (str(q.no_unit)) { args.push(str(q.no_unit)); where.push(`lower(s.no_unit) = lower($${args.length})`); }
  const rows = (await db.query(
    `SELECT s.id, to_char(s.tanggal, 'YYYY-MM-DD') AS tanggal, s.jenis, m.kode, m.nama AS material, m.satuan, g.nama AS gudang, s.qty::float AS qty, s.nilai::float AS nilai, s.no_unit, s.ref, s.pihak, s.catatan, s.grup, s.koreksi_dari,
       EXISTS (SELECT 1 FROM stok_mutasi k WHERE k.koreksi_dari = s.id) AS dikoreksi, u.name AS oleh, ${TS('s.created_at')} AS waktu
     FROM stok_mutasi s JOIN material m ON m.id = s.material_id JOIN gudang g ON g.id = s.gudang_id LEFT JOIN users u ON u.id = s.created_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 200`, args)).rows;
  return rows.map((r) => (admin ? r : { ...r, nilai: undefined }));
}

// Admin: reverse a movement (or both legs of a transfer) with an opposite entry; the original stays in the ledger.
async function gudangBatalkan(id, user) {
  return db.tx(async (c) => {
    const first = (await c.query('SELECT * FROM stok_mutasi WHERE id = $1', [id])).rows[0];
    if (!first) throw new HttpError(404, 'Transaksi tidak ditemukan.');
    if (first.jenis === 'koreksi') throw new HttpError(409, 'Koreksi tidak dapat dibatalkan lagi; catat transaksi baru.');
    const rows = first.grup ? (await c.query('SELECT * FROM stok_mutasi WHERE grup = $1 ORDER BY id', [first.grup])).rows : [first];
    await c.query('SELECT 1 FROM material WHERE id = $1 FOR UPDATE', [first.material_id]);
    for (const r of rows) {
      if ((await c.query('SELECT 1 FROM stok_mutasi WHERE koreksi_dari = $1', [r.id])).rowCount) throw new HttpError(409, 'Transaksi ini sudah dikoreksi.');
      const have = await stockIn(c, r.material_id, r.gudang_id);
      if (have + -Number(r.qty) < -0.0005) throw new HttpError(409, 'Stok saat ini tidak cukup untuk membatalkan; sebagian sudah dipakai atau dipindah.');
    }
    for (const r of rows) {
      await c.query(
        "INSERT INTO stok_mutasi (tanggal, jenis, material_id, gudang_id, qty, nilai, no_unit, ref, pihak, catatan, koreksi_dari, created_by) VALUES ($1,'koreksi',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [numbering.todayISO(), r.material_id, r.gudang_id, -Number(r.qty), -Number(r.nilai), r.no_unit, r.ref, r.pihak, 'Pembatalan transaksi #' + r.id, r.id, user.id]);
    }
    const dq = rows.reduce((a, r) => a - Number(r.qty), 0), dv = rows.reduce((a, r) => a - Number(r.nilai), 0);
    try { await c.query('UPDATE material SET stok_total = stok_total + $2, nilai_total = nilai_total + $3 WHERE id = $1', [first.material_id, dq, dv]); }
    catch (e) { if (e.code === '23514') throw new HttpError(409, 'Pembatalan ini akan membuat stok atau nilai negatif; stok sudah terpakai.'); throw e; }
    await audit(c, user.id, 'gudang.batal', 'material', first.material_id, { id, jenis: first.jenis });
  });
}

// Material used per unit (issues to a unit, net of corrections).
async function gudangPemakaian(user) {
  const admin = user.role === 'admin';
  const rows = (await db.query(
    `SELECT s.no_unit AS unit, m.id AS material_id, m.kode, m.nama, m.satuan, (-sum(s.qty))::float AS qty, (-sum(s.nilai))::float AS nilai
     FROM stok_mutasi s JOIN material m ON m.id = s.material_id
     WHERE s.no_unit <> '' AND s.jenis IN ('keluar', 'koreksi') GROUP BY s.no_unit, m.id HAVING sum(s.qty) <> 0 ORDER BY s.no_unit, m.nama`)).rows;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.unit)) by.set(r.unit, { unit: r.unit, items: [], ...(admin ? { nilai: 0 } : {}) });
    const u = by.get(r.unit); u.items.push({ material_id: r.material_id, kode: r.kode, nama: r.nama, satuan: r.satuan, qty: round3(r.qty), ...(admin ? { nilai: r.nilai } : {}) });
    if (admin) u.nilai += r.nilai;
  }
  return [...by.values()].sort((a, b) => a.unit.localeCompare(b.unit, 'id', { numeric: true }));
}


// ───────── finance ─────────
const K = () => require('../lib/keuangan');
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : str(v).slice(0, 10));

// One flat list of money lines from every source: manual entries, receipts, commission payouts, paid refunds.
async function kasLines() {
  const out = [];
  for (const r of (await db.query("SELECT id, to_char(tanggal, 'YYYY-MM-DD') AS tanggal, jenis, kategori, jumlah::float AS jumlah, pihak, keterangan, no_unit, ref, termin_id FROM kas_transaksi")).rows)
    out.push({ key: 'kas-' + r.id, sumber: r.termin_id ? 'termin' : 'kas', id: r.id, tanggal: r.tanggal, jenis: r.jenis, kategori: r.kategori, jumlah: r.jumlah, pihak: r.pihak, keterangan: r.keterangan, no_unit: r.no_unit, ref: r.ref, hapus: !r.termin_id });
  for (const r of (await db.query("SELECT id, no, to_char(tanggal, 'YYYY-MM-DD') AS tanggal, jumlah::float AS jumlah, nama, no_unit, data FROM documents WHERE jenis = 'kwitansi' AND tanggal IS NOT NULL AND jumlah > 0")).rows)
    out.push({ key: 'kw-' + r.id, sumber: 'kwitansi', tanggal: r.tanggal, jenis: 'masuk', kategori: 'penjualan', jumlah: r.jumlah, pihak: r.nama || '', keterangan: r.data && r.data.untuk ? 'Kwitansi ' + r.data.untuk : 'Kwitansi', no_unit: r.no_unit || '', ref: r.no, hapus: false });
  for (const r of (await db.query("SELECT p.id, to_char(p.tanggal, 'YYYY-MM-DD') AS tanggal, p.jumlah::float AS jumlah, s.nama, p.no_unit, p.catatan FROM commission_payouts p JOIN sales_people s ON s.id = p.sales_id")).rows)
    out.push({ key: 'ko-' + r.id, sumber: 'komisi', tanggal: r.tanggal, jenis: 'keluar', kategori: 'komisi', jumlah: r.jumlah, pihak: r.nama, keterangan: r.catatan || 'Pencairan komisi', no_unit: r.no_unit || '', ref: '', hapus: false });
  for (const r of (await db.query("SELECT id, to_char(pengembalian_tanggal, 'YYYY-MM-DD') AS tanggal, kembali::float AS jumlah, pemesan, no_unit FROM cancellations WHERE pengembalian = 'selesai' AND kembali > 0 AND pengembalian_tanggal IS NOT NULL")).rows)
    out.push({ key: 'pb-' + r.id, sumber: 'pembatalan', tanggal: r.tanggal, jenis: 'keluar', kategori: 'pengembalian', jumlah: r.jumlah, pihak: r.pemesan, keterangan: 'Pengembalian karena pembatalan', no_unit: r.no_unit, ref: '', hapus: false });
  return out;
}

async function keuangan(bulanQ) {
  const k = K(), bulan = k.isMonth(bulanQ) ? bulanQ : 'all', today = numbering.todayISO();
  const all = await kasLines();
  const inPeriod = bulan === 'all' ? all : all.filter((l) => l.tanggal.startsWith(bulan));
  const r = k.ringkas(inPeriod), total = k.ringkas(all);
  const bySumber = (jenis, sumber) => inPeriod.filter((l) => l.jenis === jenis && l.sumber === sumber).reduce((a, l) => a + l.jumlah, 0);
  const spk = await listSpk();
  const hutang = spk.filter((x) => x.status === 'berjalan').reduce((a, x) => a + x.sisa, 0);
  return {
    today, bulan, kategori: { masuk: k.KATEGORI_MASUK, keluar: k.KATEGORI_KELUAR },
    ringkasan: { masuk: r.masuk, keluar: r.keluar, saldo: r.saldo, saldoTotal: total.saldo, dariKwitansi: bySumber('masuk', 'kwitansi'), komisi: bySumber('keluar', 'komisi'), hutangSpk: hutang },
    perBulan: total.perBulan.slice(-12), perKategori: r.perKategori,
    transaksi: inPeriod.sort((a, b) => b.tanggal.localeCompare(a.tanggal) || String(b.key).localeCompare(String(a.key))).slice(0, 300),
  };
}

async function addKas(f, user) {
  const k = K(), jenis = str(f.jenis), kategori = str(f.kategori), jumlah = int(f.jumlah);
  if (!['masuk', 'keluar'].includes(jenis)) throw new HttpError(422, 'Pilih pemasukan atau pengeluaran.');
  if (!k.kategoriOK(jenis, kategori)) throw new HttpError(422, 'Kategori tidak sesuai. Komisi dan pengembalian dicatat dari menu masing-masing, dan termin kontraktor dari SPK.');
  if (['komisi', 'pengembalian', 'kontraktor'].includes(kategori)) throw new HttpError(422, 'Kategori itu terisi otomatis dari menu Komisi, Pembatalan, atau SPK; jangan dicatat dua kali.');
  if (!jumlah || jumlah <= 0) throw new HttpError(422, 'Jumlah harus lebih dari 0.');
  return db.tx(async (c) => {
    const no = str(f.no_unit) ? (await c.query('SELECT no_unit FROM units WHERE lower(no_unit) = lower($1)', [str(f.no_unit)])).rows[0] : null;
    if (str(f.no_unit) && !no) throw new HttpError(422, 'Unit tidak ditemukan.');
    const r = await c.query('INSERT INTO kas_transaksi (tanggal, jenis, kategori, jumlah, pihak, keterangan, no_unit, ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [isoDate(f.tanggal) || numbering.todayISO(), jenis, kategori, jumlah, str(f.pihak).slice(0, 120), str(f.keterangan).slice(0, 300), no ? no.no_unit : '', str(f.ref).slice(0, 80), user.id]);
    await audit(c, user.id, 'kas.add', 'kas', r.rows[0].id, { jenis, kategori, jumlah });
    return { id: r.rows[0].id };
  });
}
async function deleteKas(id, user) {
  return db.tx(async (c) => {
    const r = (await c.query('SELECT * FROM kas_transaksi WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!r) throw new HttpError(404, 'Catatan tidak ditemukan.');
    if (r.termin_id) throw new HttpError(409, 'Ini pembayaran termin SPK; batalkan dari menu SPK.');
    await c.query('DELETE FROM kas_transaksi WHERE id = $1', [id]);
    await audit(c, user.id, 'kas.delete', 'kas', id, { jenis: r.jenis, kategori: r.kategori, jumlah: Number(r.jumlah) });
  });
}

const listKontraktor = async () => (await db.query('SELECT id, nama, telp, aktif FROM kontraktor ORDER BY aktif DESC, lower(nama)')).rows;
async function saveKontraktor(id, f, user) {
  const nama = f.nama === undefined ? undefined : str(f.nama).slice(0, 100);
  if (id == null && !nama) throw new HttpError(422, 'Nama kontraktor wajib diisi.');
  if (nama === '') throw new HttpError(422, 'Nama kontraktor wajib diisi.');
  return db.tx(async (c) => {
    try {
      if (id == null) { const r = await c.query('INSERT INTO kontraktor (nama, telp) VALUES ($1,$2) RETURNING id', [nama, str(f.telp).slice(0, 30)]); await audit(c, user.id, 'kontraktor.create', 'kontraktor', r.rows[0].id, { nama }); return { id: r.rows[0].id }; }
      const r = await c.query('UPDATE kontraktor SET nama = COALESCE($2, nama), telp = COALESCE($3, telp), aktif = COALESCE($4, aktif) WHERE id = $1 RETURNING id', [id, nama ?? null, f.telp === undefined ? null : str(f.telp).slice(0, 30), f.aktif === undefined ? null : !!f.aktif]);
      if (!r.rowCount) throw new HttpError(404, 'Kontraktor tidak ditemukan.');
      await audit(c, user.id, 'kontraktor.update', 'kontraktor', id, { nama, aktif: f.aktif }); return { id };
    } catch (e) { if (e.code === '23505') throw new HttpError(409, 'Nama kontraktor itu sudah ada.'); throw e; }
  });
}

async function listSpk() {
  const k = K();
  const rows = (await db.query("SELECT s.id, s.no_spk, s.kontraktor_id, c.nama AS kontraktor, s.uraian, s.units, s.nilai::float AS nilai, to_char(s.tanggal, 'YYYY-MM-DD') AS tanggal, s.status FROM spk s JOIN kontraktor c ON c.id = s.kontraktor_id ORDER BY s.id DESC")).rows;
  const termin = (await db.query("SELECT id, spk_id, urutan, uraian, jumlah::float AS jumlah, to_char(jatuh_tempo, 'YYYY-MM-DD') AS jatuh_tempo, to_char(dibayar_tanggal, 'YYYY-MM-DD') AS dibayar_tanggal FROM spk_termin ORDER BY spk_id, urutan")).rows;
  const today = numbering.todayISO();
  return rows.map((s) => {
    const t = termin.filter((x) => x.spk_id === s.id).map((x) => ({ ...x, telat: !x.dibayar_tanggal && !!x.jatuh_tempo && x.jatuh_tempo < today }));
    return { ...s, termin: t, ...k.statusSpk(s.nilai, t), telat: s.status === 'berjalan' && t.some((x) => x.telat) };
  });
}

// ───────── notification centre ─────────
// A notification is a current task, not an audit event: it disappears as soon
// as the related payment, follow-up, stock, or deadline is handled.
async function notifications(user) {
  const admin = user && user.role === 'admin';
  const [prospek, berkasData, progres, gudang, tagihan, spk, pembatalan] = await Promise.all([
    listProspects(), berkasList(), progresList(user), gudangList(user),
    admin ? tagihanList() : null,
    admin ? listSpk() : null,
    admin ? listCancellations() : null,
  ]);
  const items = [];
  const add = (item) => items.push(item);
  const dateLabel = (date) => date ? new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: require('./config').timezone }).format(new Date(date + 'T12:00:00Z')) : '';

  for (const p of prospek.prospects) {
    if (['deal', 'gagal'].includes(p.tahap) || !p.follow_up || p.follow_up > prospek.today) continue;
    const late = p.follow_up < prospek.today;
    add({ id: `prospek-${p.id}-${p.follow_up}`, level: late ? 'urgent' : 'warning', tab: 'pr',
      title: late ? 'Tindak lanjut prospek terlambat' : 'Tindak lanjut prospek hari ini',
      detail: `${p.nama}${p.sales ? ' · ' + p.sales : ''}${late ? ' · sejak ' + dateLabel(p.follow_up) : ''}`,
      order: late ? p.follow_up : prospek.today });
  }
  for (const u of berkasData.units.filter((u) => u.telat)) {
    add({ id: `kpr-${u.unit}-${u.tenggat}`, level: 'urgent', tab: 'bk', title: 'Tenggat KPR terlewat',
      detail: `${u.unit} · ${u.pemesan || 'Pemesan'}${u.tenggatKet ? ' · ' + u.tenggatKet : ''}`, order: u.tenggat });
  }
  for (const u of progres.units.filter((u) => u.hariTelat > 0)) {
    add({ id: `serah-${u.unit}-${u.batas}`, level: 'urgent', tab: 'pb', title: 'Serah terima melewati batas',
      detail: `${u.unit} · ${u.pemesan || 'Pemesan'} · terlambat ${u.hariTelat} hari`, order: u.batas });
  }
  for (const m of gudang.material.filter((m) => m.aktif && m.bawah)) {
    const empty = m.stok === 0;
    add({ id: `stok-${m.id}-${m.stok}`, level: empty ? 'urgent' : 'warning', tab: 'gd',
      title: empty ? 'Stok material habis' : 'Stok material di bawah minimum',
      detail: `${m.nama} · ${m.stok} ${m.satuan}${empty ? '' : ' (minimum ' + m.minimum + ')'}`, order: empty ? '0000' : '5000' });
  }
  if (admin) {
    for (const u of tagihan.units.filter((u) => u.hariTelat > 0)) {
      add({ id: `tagihan-${u.unit}-${u.next && u.next.due}`, level: 'urgent', tab: 'pt', title: 'Tagihan terlambat',
        detail: `${u.unit} · ${u.pemesan || 'Pemesan'} · terlambat ${u.hariTelat} hari`, order: u.next && u.next.due || '0000' });
    }
    for (const s of spk.filter((s) => s.status === 'berjalan')) for (const t of s.termin.filter((t) => t.telat)) {
      add({ id: `termin-${t.id}`, level: 'urgent', tab: 'kn', title: 'Termin SPK terlambat',
        detail: `${s.no_spk} · ${t.uraian}${t.jatuh_tempo ? ' · sejak ' + dateLabel(t.jatuh_tempo) : ''}`, order: t.jatuh_tempo || '0000' });
    }
    for (const c of pembatalan.filter((c) => c.pengembalian === 'menunggu')) {
      add({ id: `refund-${c.id}`, level: 'warning', tab: 'pt', title: 'Pengembalian menunggu diproses',
        detail: `${c.no_unit} · ${c.pemesan || 'Pemesan'}`, order: c.tanggal || '5000' });
    }
  }
  const rank = { urgent: 0, warning: 1, info: 2 };
  items.sort((a, b) => rank[a.level] - rank[b.level] || String(a.order).localeCompare(String(b.order)) || a.title.localeCompare(b.title, 'id'));
  return { today: prospek.today, total: items.length, urgent: items.filter((i) => i.level === 'urgent').length, items: items.slice(0, 50) };
}

async function createSpk(f, user) {
  const no = str(f.no_spk).slice(0, 40), uraian = str(f.uraian).slice(0, 300), nilai = int(f.nilai);
  if (!no) throw new HttpError(422, 'Nomor SPK wajib diisi.');
  if (!uraian) throw new HttpError(422, 'Uraian pekerjaan wajib diisi.');
  if (!nilai || nilai <= 0) throw new HttpError(422, 'Nilai SPK harus lebih dari 0.');
  const termin = (Array.isArray(f.termin) ? f.termin : []).map((t) => ({ uraian: str(t.uraian).slice(0, 120), jumlah: int(t.jumlah), jatuh_tempo: isoDate(t.jatuh_tempo) }));
  if (!termin.length) throw new HttpError(422, 'Isi minimal satu termin pembayaran.');
  if (termin.some((t) => !t.uraian || !t.jumlah || t.jumlah <= 0)) throw new HttpError(422, 'Setiap termin perlu uraian dan jumlah lebih dari 0.');
  const total = termin.reduce((a, t) => a + t.jumlah, 0);
  if (total !== nilai) throw new HttpError(422, `Jumlah termin (${total.toLocaleString('id-ID')}) harus sama dengan nilai SPK (${nilai.toLocaleString('id-ID')}).`);
  return db.tx(async (c) => {
    const kt = (await c.query('SELECT aktif FROM kontraktor WHERE id = $1', [int(f.kontraktor_id)])).rows[0];
    if (!kt || !kt.aktif) throw new HttpError(422, 'Pilih kontraktor yang aktif.');
    let id;
    try { id = (await c.query('INSERT INTO spk (no_spk, kontraktor_id, uraian, units, nilai, tanggal, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [no, int(f.kontraktor_id), uraian, str(f.units).slice(0, 200), nilai, isoDate(f.tanggal) || numbering.todayISO(), user.id])).rows[0].id; }
    catch (e) { if (e.code === '23505') throw new HttpError(409, 'Nomor SPK itu sudah dipakai.'); throw e; }
    for (const [i, t] of termin.entries()) await c.query('INSERT INTO spk_termin (spk_id, urutan, uraian, jumlah, jatuh_tempo) VALUES ($1,$2,$3,$4,$5)', [id, i + 1, t.uraian, t.jumlah, t.jatuh_tempo]);
    await audit(c, user.id, 'spk.create', 'spk', id, { no_spk: no, nilai });
    return { id };
  });
}
async function setSpkStatus(id, f, user) {
  const status = str(f.status);
  if (!['berjalan', 'selesai', 'batal'].includes(status)) throw new HttpError(422, 'Status tidak dikenal.');
  return db.tx(async (c) => {
    const r = (await c.query('UPDATE spk SET status = $2 WHERE id = $1 RETURNING no_spk', [id, status])).rows[0];
    if (!r) throw new HttpError(404, 'SPK tidak ditemukan.');
    await audit(c, user.id, 'spk.status', 'spk', id, { no_spk: r.no_spk, status });
  });
}
async function bayarTermin(id, f, user) {
  return db.tx(async (c) => {
    const t = (await c.query('SELECT t.*, s.no_spk, s.status, k.nama AS kontraktor FROM spk_termin t JOIN spk s ON s.id = t.spk_id JOIN kontraktor k ON k.id = s.kontraktor_id WHERE t.id = $1 FOR UPDATE OF t', [id])).rows[0];
    if (!t) throw new HttpError(404, 'Termin tidak ditemukan.');
    if (t.dibayar_tanggal) throw new HttpError(409, 'Termin ini sudah dibayar.');
    if (t.status === 'batal') throw new HttpError(409, 'SPK ini dibatalkan.');
    const tanggal = isoDate(f.tanggal) || numbering.todayISO();
    await c.query("INSERT INTO kas_transaksi (tanggal, jenis, kategori, jumlah, pihak, keterangan, ref, termin_id, created_by) VALUES ($1,'keluar','kontraktor',$2,$3,$4,$5,$6,$7)", [tanggal, t.jumlah, t.kontraktor, t.uraian, t.no_spk, id, user.id]);
    await c.query('UPDATE spk_termin SET dibayar_tanggal = $2 WHERE id = $1', [id, tanggal]);
    await audit(c, user.id, 'spk.bayar', 'spk', t.spk_id, { no_spk: t.no_spk, termin: t.uraian, jumlah: Number(t.jumlah) });
  });
}
async function batalBayarTermin(id, user) {
  return db.tx(async (c) => {
    const t = (await c.query('SELECT t.*, s.no_spk FROM spk_termin t JOIN spk s ON s.id = t.spk_id WHERE t.id = $1 FOR UPDATE OF t', [id])).rows[0];
    if (!t) throw new HttpError(404, 'Termin tidak ditemukan.');
    if (!t.dibayar_tanggal) throw new HttpError(409, 'Termin ini belum dibayar.');
    await c.query('DELETE FROM kas_transaksi WHERE termin_id = $1', [id]);
    await c.query('UPDATE spk_termin SET dibayar_tanggal = NULL WHERE id = $1', [id]);
    await audit(c, user.id, 'spk.batal-bayar', 'spk', t.spk_id, { no_spk: t.no_spk, termin: t.uraian });
  });
}

// ───────── users ─────────
const USERNAME = /^[a-z0-9._-]{3,32}$/i;
const userCols = `id, username, name, role, active, ${TS('created_at')} AS created_at, ${TS('last_login')} AS last_login`;
const listUsers = async () => (await db.query(`SELECT ${userCols} FROM users ORDER BY active DESC, lower(username)`)).rows;

async function createUser({ username, name, password, role }, actor) {
  username = str(username); name = str(name);
  if (!USERNAME.test(username)) throw new HttpError(400, 'Username 3–32 karakter: huruf, angka, titik, garis bawah atau strip.');
  if (!name) throw new HttpError(400, 'Nama wajib diisi.');
  if (!['admin', 'staff'].includes(role)) throw new HttpError(400, 'Peran tidak valid.');
  checkPasswordStrength(password);
  const hash = await hashPassword(password);
  try {
    const r = await db.query('INSERT INTO users (username, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id', [username, name, hash, role]);
    await audit(db, actor?.id, 'user.create', 'user', r.rows[0].id, { username, role });
    return r.rows[0].id;
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Username sudah dipakai.');
    throw e;
  }
}

async function updateUser(id, patch, actor) {
  return db.tx(async (c) => {
    const u = (await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!u) throw new HttpError(404, 'Pengguna tidak ditemukan.');
    const role = patch.role ?? u.role;
    const active = patch.active ?? u.active;
    if (!['admin', 'staff'].includes(role)) throw new HttpError(400, 'Peran tidak valid.');
    if (u.role === 'admin' && u.active && (role !== 'admin' || !active)) {
      const others = (await c.query("SELECT count(*)::int n FROM users WHERE role='admin' AND active AND id <> $1", [id])).rows[0].n;
      if (!others) throw new HttpError(400, 'Harus ada minimal satu admin aktif.');
    }
    const name = patch.name !== undefined ? str(patch.name) : u.name;
    if (!name) throw new HttpError(400, 'Nama wajib diisi.');
    let hash = u.password_hash;
    if (patch.password) { checkPasswordStrength(patch.password); hash = await hashPassword(patch.password); }
    await c.query('UPDATE users SET name=$1, role=$2, active=$3, password_hash=$4 WHERE id=$5', [name, role, !!active, hash, id]);
    if (!active || patch.password) await c.query('DELETE FROM sessions WHERE user_id = $1', [id]); // force re-login
    await audit(c, actor.id, 'user.update', 'user', id, { username: u.username, role, active, password_reset: !!patch.password });
  });
}

async function changeOwnPassword(user, current, next) {
  const row = (await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id])).rows[0];
  if (!row || !(await verifyPassword(String(current ?? ''), row.password_hash))) throw new HttpError(400, 'Password saat ini salah.');
  checkPasswordStrength(next);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(next), user.id]);
  await audit(db, user.id, 'user.password', 'user', user.id, null);
}

async function authenticate(username, password) {
  const u = (await db.query('SELECT * FROM users WHERE lower(username) = lower($1)', [str(username)])).rows[0];
  // Verify against a dummy hash for unknown users so timing does not reveal which usernames exist.
  const ok = await verifyPassword(String(password ?? ''), u ? u.password_hash : DUMMY);
  if (!u || !ok) return null;
  if (!u.active) return { inactive: true }; // only said after the right password, so it does not reveal which usernames exist
  await db.query('UPDATE users SET last_login = now() WHERE id = $1', [u.id]);
  return { id: u.id, username: u.username, name: u.name, role: u.role };
}
let DUMMY = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);

// First start of an installation: fill the stock with the 36 template units, all "tersedia". Runs at most once per
// database (a marker row is written even when units already exist), so units an admin later deletes stay deleted.
async function seedDefaultUnits() {
  return db.tx(async (c) => {
    const marked = await c.query("INSERT INTO counters (name, last) VALUES ('seed-units', 1) ON CONFLICT (name) DO NOTHING RETURNING name");
    if (!marked.rowCount) return 0;                                   // already handled on an earlier start
    if ((await c.query('SELECT count(*)::int n FROM units')).rows[0].n) return 0; // existing installation: leave its stock alone
    let added = 0;
    for (const u of require('../lib/unit-plan').UNITS) added += (await c.query('INSERT INTO units (no_unit, type) VALUES ($1, $2) ON CONFLICT (lower(no_unit)) DO NOTHING', [u.no_unit, u.type])).rowCount;
    return added;
  });
}

async function ensureAdmin(cfg) {
  const n = (await db.query('SELECT count(*)::int n FROM users')).rows[0].n;
  if (n || !cfg.username || !cfg.password) return false;
  await createUser({ username: cfg.username, name: cfg.name, password: cfg.password, role: 'admin' }, null);
  return true;
}

const AUDIT_MAX = 100; // the activity list shows at most the latest 100 entries
const listAudit = async (limit = AUDIT_MAX) => (await db.query(
  `SELECT a.id, ${TS('a.at')} AS at, u.name AS user, a.action, a.entity, a.entity_id, a.detail FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT $1`, [Math.min(Math.max(1, Math.trunc(Number(limit)) || AUDIT_MAX), AUDIT_MAX)])).rows;

module.exports = {
  audit, keuangan, addKas, deleteKas, listKontraktor, saveKontraktor, listSpk, createSpk, setSpkStatus, bayarTermin, batalBayarTermin, gudangList, createMaterial, updateMaterial, saveGudang, gudangTransaksi, gudangRiwayat, gudangBatalkan, gudangPemakaian, progresList, progresUnit, setProgres, addFoto, getFoto, deleteFoto, addPunch, setPunch, deletePunch, createHandover, bastData, berkasList, setBerkasItem, setBerkasInfo, kprEvents, listSalesNames, listProspects, createProspect, updateProspect, deleteProspect, listProspectNotes, addProspectNote, convertProspect, listSales, createSales, updateSales, komisi, addPayout, deletePayout, salesReport, tagihanList, jadwalUnit, cancelPreview, cancelOrder, listCancellations, markRefund, notifications, saveUpload, getUpload, deleteUpload, purgeOrphanUploads, createDocument, updateDocument, listDocuments, getDocument, getDocumentFiles, getPdf, savePdf, listUnits, addUnits, updateUnit, deleteUnit,
  listUsers, createUser, updateUser, changeOwnPassword, authenticate, ensureAdmin, seedDefaultUnits, listAudit, str,
};
