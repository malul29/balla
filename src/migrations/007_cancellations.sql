-- Cancelled orders: why, how much was paid, what the company keeps and what goes back to the buyer.
-- doc_cutoff closes the unit's payment cycle: documents of that unit up to this id belong to the cancelled order
-- and no longer count in receivables or the sales report.
CREATE TABLE cancellations (
  id                   BIGSERIAL PRIMARY KEY,
  no_unit              TEXT NOT NULL,
  type                 TEXT NOT NULL DEFAULT '',
  pemesan              TEXT NOT NULL DEFAULT '',
  surat_no             TEXT NOT NULL DEFAULT '',
  tanggal              DATE NOT NULL,
  alasan               TEXT NOT NULL CHECK (alasan IN ('pembeli', 'bank', 'wanprestasi', 'lainnya')),
  catatan              TEXT NOT NULL DEFAULT '',
  dibayar              BIGINT NOT NULL DEFAULT 0,
  hangus               BIGINT NOT NULL DEFAULT 0,
  kembali              BIGINT NOT NULL DEFAULT 0,
  pengembalian         TEXT NOT NULL DEFAULT 'menunggu' CHECK (pengembalian IN ('menunggu', 'selesai', 'tidak-ada')),
  pengembalian_tanggal DATE,
  doc_cutoff           BIGINT NOT NULL,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cancellations_unit_idx ON cancellations (lower(no_unit));
