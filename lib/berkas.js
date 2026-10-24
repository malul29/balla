// What a buyer's file must contain, and the bank (KPR) stages. Pure data + helpers, no database.

const ITEMS = {
  pembeli: [
    { kode: 'ktp', label: 'KTP pembeli (dan pasangan)' }, { kode: 'kk', label: 'Kartu Keluarga' }, { kode: 'npwp', label: 'NPWP' },
  ],
  kpr: [
    { kode: 'nikah', label: 'Surat nikah / belum menikah' }, { kode: 'slip', label: 'Slip gaji / bukti penghasilan' }, { kode: 'rekening', label: 'Rekening koran 3 bulan' },
    { kode: 'form-bank', label: 'Formulir aplikasi KPR' }, { kode: 'sp3k', label: 'SP3K (persetujuan kredit)' },
  ],
  legal: [
    { kode: 'ppjb', label: 'PPJB ditandatangani' }, { kode: 'akad', label: 'Akad kredit / AJB' }, { kode: 'sertifikat', label: 'Sertifikat / balik nama' }, { kode: 'pbg', label: 'PBG / IMB' },
  ],
};
const GRUP = { pembeli: 'Berkas pembeli', kpr: 'Berkas KPR', legal: 'Legal' };

// The checklist of one unit: KPR adds the bank papers; the akad item reads "Akad kredit" or "AJB" accordingly.
function checklist(cara) {
  const kpr = cara === 'kpr';
  const out = [];
  for (const g of ['pembeli', ...(kpr ? ['kpr'] : []), 'legal']) {
    for (const it of ITEMS[g]) out.push({ ...it, grup: g, label: it.kode === 'akad' ? (kpr ? 'Akad kredit' : 'AJB (akta jual beli)') : it.label });
  }
  return out;
}

const KPR_TAHAP = ['berkas', 'pengajuan', 'analisa', 'sp3k', 'akad', 'cair', 'ditolak'];
const KPR_LABEL = { berkas: 'Melengkapi berkas', pengajuan: 'Diajukan ke bank', analisa: 'Analisa bank', sp3k: 'SP3K terbit', akad: 'Akad kredit', cair: 'Dana cair', ditolak: 'Ditolak bank' };
const KPR_DONE = new Set(['cair', 'ditolak']);

const isLate = (tenggat, tahap, today) => !!tenggat && tenggat < today && !KPR_DONE.has(tahap);

module.exports = { checklist, GRUP, KPR_TAHAP, KPR_LABEL, KPR_DONE, isLate };
