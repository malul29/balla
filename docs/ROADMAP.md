# Roadmap: Balla

Tujuan: platform administrasi perumahan **internal** PT. Balla Sultana Samata. Keputusan: ini alat internal, bukan produk untuk developer lain, jadi tidak ada pemisahan antar-perusahaan. Dukungan beberapa proyek ditunda sampai perusahaan benar-benar punya proyek kedua.

Status: M3 selesai, berikutnya M4. Tanda ✅ = selesai, 🔨 = sedang dikerjakan.

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

### M2. Pembayaran dan piutang ✅
- Kwitansi untuk **Reservasi, Booking Fee, Uang Muka ke-N, atau Pelunasan**. Di form kwitansi, memilih unit menampilkan tagihan yang masih terbuka; satu klik mengisi "untuk", DP ke-, jumlah, dan nama pembayar.
- **Halaman Piutang** (admin): sisa tagihan, terlambat, jatuh tempo 30 hari; filter dan pencarian; detail per baris jadwal dengan kwitansi yang melunasinya; peringatan bila jumlah jadwal berbeda dari Harga Pengikatan; unduh CSV.
- **Denda keterlambatan** sesuai S&K: 1 per mil per hari dari jumlah yang belum dibayar, maksimal 30 hari, ikut turun bila ada pembayaran sebagian. Lewat 30 hari ditandai "lewat toleransi".
- **Pembatalan pesanan** (admin): alasan, saran pembagian dari S&K (hak perusahaan dan yang dikembalikan, bisa diubah), unit kembali tersedia, siklus pembayaran lama ditutup (kwitansi lama tidak lagi dihitung untuk pemesan berikutnya), pelacakan pengembalian.
- **Pengingat WhatsApp**: tombol yang membuka pesan siap kirim ke nomor di SKU/SPU (tanpa biaya layanan).
- Perhitungan memakai kwitansi yang sudah ada, tanpa tabel pembayaran terpisah, jadi koreksi kwitansi otomatis mengoreksi piutang.

Sisa yang sengaja ditunda
- Pengingat otomatis terjadwal (butuh WhatsApp Business API berbayar atau layanan email).
- Denda belum bisa ditagih atau dicatat sebagai dibayar; saat ini hanya dihitung dan ditampilkan.
- Kwitansi dengan jumlah lebih dari tagihan dialokasikan otomatis ke tagihan terlama; belum ada layar untuk memindahkan alokasi manual.

### M3. Pemasaran dan komisi ✅
- **Prospek** (semua pengguna): nama, telepon, sumber, minat tipe, sales, tahap (baru → dihubungi → survey → negosiasi → deal / batal), jadwal tindak lanjut. Ringkasan di atas: prospek aktif, perlu tindak lanjut (hari ini dan terlambat), deal bulan ini, konversi.
- **Riwayat komunikasi** per prospek (telepon, WhatsApp, kunjungan, catatan). Catatan pertama menggeser prospek baru ke "dihubungi"; tanggal tindak lanjut berikutnya bisa diganti saat mencatat. Tombol WhatsApp membuka pesan sapaan siap kirim.
- **Jadikan pemesan** (admin): menghubungkan prospek ke unit yang sudah dipesan lewat SKU/SPU. Satu unit hanya bisa terhubung ke satu prospek. Pembatalan pesanan melepas prospek (tahap batal, dengan catatan otomatis).
- **Komisi sales** (admin): daftar sales (inhouse, freelance, agen) dengan persentase. Hak komisi = persentase dari uang yang sudah diterima untuk unit itu, tidak melebihi tagihan. Persentase dikunci saat prospek jadi pemesan, jadi perubahan tarif tidak mengubah deal lama. Pencairan dicatat per sales; saldo = hak - dicairkan, dan bisa negatif bila ada pembatalan sesudah pencairan.
- Staf melihat dan mengisi prospek, tetapi nilai komisi, daftar tarif, dan penghubungan unit hanya untuk admin (dijaga di server).

Sisa yang sengaja ditunda
- Komisi bertahap dengan syarat (misalnya cair saat DP lunas) dan tarif berbeda per tipe unit.
- Impor prospek dari iklan (Meta/Google) atau formulir website.
- Pengingat tindak lanjut otomatis lewat WhatsApp/email.
- Bila ingin pembedaan prospek per staf (staf hanya melihat prospeknya sendiri), perlu aturan akses baru.

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
