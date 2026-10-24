# Housing Platform

Platform administrasi perumahan untuk developer: penjualan, pembayaran, KPR, legal, pembangunan, serah terima, dan laporan.

Proyek ini **dimulai dari salinan Sultana Desk** (`../app`, berjalan di production untuk Sultana Living) dan dikembangkan terpisah. Perubahan di sini tidak memengaruhi Sultana Desk, dan sebaliknya.

## Terpisah dari Sultana Desk

| | Sultana Desk (`../app`) | Housing Platform (folder ini) |
|---|---|---|
| Repo git | `malul29/sultana-desk` | repo sendiri (belum punya remote) |
| Port aplikasi (dev) | 3000 | **3100** |
| Port PostgreSQL (dev) | 54320 | **54420** |
| Data lokal | `app/data/` | `data/` di folder ini |
| Nama database | `sultana` | `housing` |
| Docker Compose | `name: sultana` | `name: housing` (volume dan container berbeda, aman di server yang sama) |

## Menjalankan

```bash
npm ci
npm run dev        # http://localhost:3100  (login lokal: admin / admin12345)
npm test
```

## Keadaan sekarang

Masih berisi isi Sultana Living (nama, logo, template dokumen, S&K, daftar unit, masterplan, rekening). Itu sengaja belum diubah: langkah pertama adalah membuatnya **berbasis data per proyek**, lihat [docs/ROADMAP.md](docs/ROADMAP.md).

- [docs/ROADMAP.md](docs/ROADMAP.md): rencana modul dan urutan pengerjaan
- [docs/PRD.md](docs/PRD.md): PRD Sultana Desk (kondisi awal fitur yang diwarisi)
- [DEPLOY.md](DEPLOY.md): panduan penyebaran (masih mengacu ke Sultana Desk)
