# Roadmap: Balla

Tujuan: platform administrasi perumahan **internal** PT. Balla Sultana Samata. Keputusan: ini alat internal, bukan produk untuk developer lain, jadi tidak ada pemisahan antar-perusahaan. Dukungan beberapa proyek ditunda sampai perusahaan benar-benar punya proyek kedua.

Status: M2 sedang dikerjakan. Tanda ✅ = selesai, 🔨 = sedang dikerjakan.

## 0. Yang diwarisi dari Sultana Desk

Dokumen penjualan bernomor (SKU, SPU, kwitansi, tanda terima), stok unit dan masterplan, riwayat dan koreksi oleh admin, unggah berkas, laporan penjualan dasar, peran admin dan staf, log aktivitas, penyebaran Docker.

## 1. Yang masih tertanam untuk Sultana Living (harus menjadi data)

| Tempat | Isi yang tertanam |
|---|---|
| `lib/company.js` | nama perusahaan, alamat, telepon footer |
| `lib/unit-types.js` | tipe unit (Deluxe, Executive, Premiere) dan luasnya |
| `lib/unit-plan.js` | daftar 36 unit awal |
| `lib/masterplan.js`, `assets/masterplan.webp` | denah kavling, posisi tiap lot, legenda |
| `lib/terms.js` | syarat dan ketentuan, rekening SKU dan SPU |
| `lib/validation.js` | daftar rekening penerima |
| `lib/docs.js`, `assets/logo-*.png` | template dokumen, logo, warna |
| `src/numbering.js` | format nomor `NNN/SL-BSS/<bulan>/<tahun>` |
| `public/*.html` | nama dan logo di tampilan |

## 2. Tahap pengerjaan

### M1. Multi-proyek (ditunda)
Tidak perlu selama hanya ada satu proyek. Bagian "Yang masih tertanam" di atas tetap berguna sebagai daftar kalau kelak proyek kedua datang.

### M2. Pembayaran dan piutang 🔨
Pencatatan pembayaran per baris jadwal, kwitansi tertaut ke jadwal, jatuh tempo, denda keterlambatan, pengingat, laporan piutang, pembatalan pesanan beserta alasan dan aturan uang hangus atau kembali.

### M3. Pemasaran dan komisi
Prospek (leads), tindak lanjut, riwayat komunikasi, konversi menjadi pemesan, perhitungan komisi sales dari pembayaran yang sudah masuk.

### M4. KPR dan legal
Daftar kelengkapan berkas per pembeli, status tiap tahap bank (pengajuan, SP3K, akad), tenggat, arsip PPJB, akad, sertifikat, IMB/PBG.

### M5. Teknik dan serah terima
SPK dan kontraktor, tahapan kerja, progres per unit dengan foto, termin pembayaran kontraktor, daftar periksa serah terima, BAST, denda keterlambatan.

### M6. Gudang dan material
Master material, gudang, penerimaan dan pengeluaran, mutasi, pemakaian per unit.

### M7. Keuangan
Pengajuan dan persetujuan pembayaran bertingkat, ekspor ke aplikasi akuntansi. Neraca dan laba rugi sendiri hanya jika ada klien yang membutuhkan dan akuntan yang meninjau.

### Lintas modul (dikerjakan bertahap bersama modul di atas)
Notifikasi WhatsApp dan email, tanda tangan jarak jauh dan tersertifikasi, e-meterai, portal pembeli, aplikasi lapangan untuk foto progres, dasbor per peran, pemantauan error dan cadangan terjadwal, penyimpanan berkas di luar database.

## 3. Keputusan
1. ✅ Alat internal Sultana Living (bukan produk untuk developer lain).
2. ✅ Nama: **Balla**.
3. Terbuka: jenis tanda tangan yang diterima notaris dan bank.
4. Terbuka: akuntansi dibangun sendiri atau cukup diekspor.
