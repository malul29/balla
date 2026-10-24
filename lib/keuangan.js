// Finance helpers: categories and the roll-ups of a flat list of cash lines. Pure functions, no database.

const KATEGORI_MASUK = { penjualan: 'Penjualan unit', lain: 'Pemasukan lain' };
const KATEGORI_KELUAR = {
  material: 'Material', upah: 'Upah dan tukang', kontraktor: 'Kontraktor (termin SPK)', operasional: 'Operasional kantor', gaji: 'Gaji',
  pajak: 'Pajak dan perizinan', pemasaran: 'Pemasaran', komisi: 'Komisi sales', pengembalian: 'Pengembalian ke pemesan', lain: 'Pengeluaran lain',
};
const kategoriOK = (jenis, k) => Object.prototype.hasOwnProperty.call(jenis === 'masuk' ? KATEGORI_MASUK : KATEGORI_KELUAR, k);

const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));

// lines: [{ tanggal:'YYYY-MM-DD', jenis:'masuk'|'keluar', kategori, jumlah }]
function ringkas(lines) {
  const sum = { masuk: 0, keluar: 0 }, per = new Map(), kat = new Map();
  for (const l of lines) {
    const n = Number(l.jumlah) || 0; if (n <= 0 || (l.jenis !== 'masuk' && l.jenis !== 'keluar')) continue;
    sum[l.jenis] += n;
    const m = String(l.tanggal).slice(0, 7);
    if (!per.has(m)) per.set(m, { bulan: m, masuk: 0, keluar: 0 }); per.get(m)[l.jenis] += n;
    const k = l.jenis + ':' + l.kategori;
    if (!kat.has(k)) kat.set(k, { jenis: l.jenis, kategori: l.kategori, jumlah: 0 }); kat.get(k).jumlah += n;
  }
  return {
    masuk: sum.masuk, keluar: sum.keluar, saldo: sum.masuk - sum.keluar,
    perBulan: [...per.values()].sort((a, b) => a.bulan.localeCompare(b.bulan)).map((x) => ({ ...x, saldo: x.masuk - x.keluar })),
    perKategori: [...kat.values()].sort((a, b) => b.jumlah - a.jumlah),
  };
}

// termin: [{ jumlah, dibayar_tanggal }] of one SPK
function statusSpk(nilai, termin) {
  const dibayar = termin.reduce((a, t) => a + (t.dibayar_tanggal ? Number(t.jumlah) : 0), 0);
  return { dibayar, sisa: Number(nilai) - dibayar, persen: nilai > 0 ? Math.round((dibayar / nilai) * 100) : 0 };
}

module.exports = { KATEGORI_MASUK, KATEGORI_KELUAR, kategoriOK, isMonth, ringkas, statusSpk };
