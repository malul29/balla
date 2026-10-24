// Construction progress and handover (serah terima). Pure data + helpers, no database.

// Work stages of a house with their weight in the total (sums to 100).
const STAGES = [
  { kode: 'pondasi', label: 'Persiapan dan pondasi', bobot: 15 },
  { kode: 'struktur', label: 'Struktur dan dinding', bobot: 25 },
  { kode: 'atap', label: 'Rangka dan penutup atap', bobot: 15 },
  { kode: 'mep', label: 'Instalasi listrik dan air', bobot: 15 },
  { kode: 'plester', label: 'Plesteran, lantai, plafon', bobot: 15 },
  { kode: 'finishing', label: 'Pengecatan dan finishing', bobot: 15 },
];

// persen: { kode: 0..100 } → overall 0..100 (rounded)
function overall(persen) {
  const sum = STAGES.reduce((a, s) => a + s.bobot * Math.min(100, Math.max(0, Number(persen && persen[s.kode]) || 0)), 0);
  return Math.round(sum / STAGES.reduce((a, s) => a + s.bobot, 0));
}

const day = (iso) => Date.parse(iso + 'T00:00:00Z');
const isISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
// Same day-of-month n months later; a short month clamps to its last day (31 Jan + 1 month = 28/29 Feb).
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

// S&K Surat Pesanan: handover is due 12 months after the full payment (or the first instalment); past a further
// 6 months of tolerance the company owes 1 o/oo per day of the unfinished work, at most 3% of it.
const SERAH_BULAN = 12, TOLERANSI_BULAN = 6, DENDA_RATE = 0.001, DENDA_MAX = 0.03;

function jadwalSerah(acuan, today) {
  if (!isISO(acuan)) return { target: '', batas: '', hariTelat: 0 };
  const target = addMonths(acuan, SERAH_BULAN), batas = addMonths(target, TOLERANSI_BULAN);
  const hariTelat = isISO(today) && today > batas ? Math.round((day(today) - day(batas)) / 864e5) : 0;
  return { target, batas, hariTelat };
}
// sisa: value of the work still unfinished (Rp); hari: days past the tolerance
function dendaSerah(sisa, hari) {
  const s = Math.max(0, Math.round(Number(sisa) || 0)), h = Math.max(0, hari | 0);
  return Math.min(Math.round(s * DENDA_RATE * h), Math.round(s * DENDA_MAX));
}

module.exports = { STAGES, overall, addMonths, jadwalSerah, dendaSerah, SERAH_BULAN, TOLERANSI_BULAN };
