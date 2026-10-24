// Warehouse arithmetic: quantities with 3 decimals, value in whole rupiah at moving-average cost. Pure functions.

const qty3 = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN; };

// Cost of taking `qty` out of a stock of `stok` units worth `nilai`: proportional, and the last unit takes
// whatever value is left so nothing stays behind in an empty store.
function biayaKeluar(stok, nilai, qty) {
  if (!(qty > 0) || !(stok > 0)) return 0;
  if (qty >= stok) return Math.round(nilai);
  return Math.min(Math.round(nilai), Math.round((nilai * qty) / stok));
}

// Value added by receiving qty at unit price (price may be unknown → falls back to the current average).
function nilaiMasuk(stok, nilai, qty, harga) {
  if (harga != null && Number.isFinite(Number(harga)) && Number(harga) >= 0) return Math.round(qty * Number(harga));
  return stok > 0 ? Math.round((nilai * qty) / stok) : 0;
}

const JENIS = ['masuk', 'keluar', 'mutasi', 'opname'];
module.exports = { qty3, biayaKeluar, nilaiMasuk, JENIS };
