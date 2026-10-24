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
async function piutang() {
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
  const u = (await piutang()).units.find((x) => x.unit.toLowerCase() === str(noUnit).toLowerCase());
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
    if (old.tahap === 'deal' && d.tahap && d.tahap !== 'deal') throw new HttpError(409, 'Prospek ini sudah menjadi pemesan unit ' + old.no_unit + '. Batalkan pesanannya di menu Piutang bila batal.');
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
  const pt = await piutang();
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
  audit, berkasList, setBerkasItem, setBerkasInfo, kprEvents, listSalesNames, listProspects, createProspect, updateProspect, deleteProspect, listProspectNotes, addProspectNote, convertProspect, listSales, createSales, updateSales, komisi, addPayout, deletePayout, salesReport, piutang, jadwalUnit, cancelPreview, cancelOrder, listCancellations, markRefund, saveUpload, getUpload, deleteUpload, purgeOrphanUploads, createDocument, updateDocument, listDocuments, getDocument, getDocumentFiles, getPdf, savePdf, listUnits, addUnits, updateUnit, deleteUnit,
  listUsers, createUser, updateUser, changeOwnPassword, authenticate, ensureAdmin, seedDefaultUnits, listAudit, str,
};
