# Balla

Platform administrasi perumahan **internal** PT. Balla Sultana Samata (Sultana Living): penjualan, pembayaran dan piutang, KPR, legal, pembangunan, serah terima, dan laporan.

Balla dimulai dari salinan **Sultana Desk** (`../app`, yang berjalan di production) dan dikembangkan terpisah. Perubahan di sini tidak memengaruhi Sultana Desk, dan sebaliknya.

## Terpisah dari Sultana Desk

| | Sultana Desk (`../app`) | Balla (folder ini) |
|---|---|---|
| Repo git | `malul29/sultana-desk` | repo sendiri (belum punya remote) |
| Port aplikasi (dev) | 3000 | **3100** |
| Port PostgreSQL (dev) | 54320 | **54420** |
| Data lokal | `app/data/` | `data/` di folder ini |
| Nama database | `sultana` | `balla` |
| Docker Compose | `name: sultana` | `name: balla` (container dan volume berbeda, aman di server yang sama) |

## Menjalankan

```bash
npm ci
npm run dev        # http://localhost:3100  (login lokal: admin / admin12345)
npm test
```

## Dokumen

- [docs/ROADMAP.md](docs/ROADMAP.md): modul dan urutan pengerjaan, beserta kemajuannya
- [docs/PRD.md](docs/PRD.md): PRD Sultana Desk (fitur awal yang diwarisi)
- [DEPLOY.md](DEPLOY.md): panduan penyebaran
