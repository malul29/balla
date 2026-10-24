-- Finance: manual cash entries, contractors, work orders (SPK) and their payment terms (termin).
-- Money received on receipts (kwitansi), commission payouts and refunds are read from their own tables, not copied here.
CREATE TABLE kontraktor (
  id    SERIAL PRIMARY KEY,
  nama  TEXT NOT NULL,
  telp  TEXT NOT NULL DEFAULT '',
  aktif BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX kontraktor_nama_key ON kontraktor (lower(nama));

CREATE TABLE spk (
  id            BIGSERIAL PRIMARY KEY,
  no_spk        TEXT NOT NULL,
  kontraktor_id INTEGER NOT NULL REFERENCES kontraktor(id) ON DELETE RESTRICT,
  uraian        TEXT NOT NULL,
  units         TEXT NOT NULL DEFAULT '',
  nilai         BIGINT NOT NULL CHECK (nilai > 0),
  tanggal       DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'berjalan' CHECK (status IN ('berjalan', 'selesai', 'batal')),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX spk_no_key ON spk (lower(no_spk));

CREATE TABLE spk_termin (
  id            BIGSERIAL PRIMARY KEY,
  spk_id        BIGINT NOT NULL REFERENCES spk(id) ON DELETE CASCADE,
  urutan        SMALLINT NOT NULL,
  uraian        TEXT NOT NULL,
  jumlah        BIGINT NOT NULL CHECK (jumlah > 0),
  jatuh_tempo   DATE,
  dibayar_tanggal DATE
);
CREATE INDEX spk_termin_spk_idx ON spk_termin (spk_id, urutan);

CREATE TABLE kas_transaksi (
  id         BIGSERIAL PRIMARY KEY,
  tanggal    DATE NOT NULL,
  jenis      TEXT NOT NULL CHECK (jenis IN ('masuk', 'keluar')),
  kategori   TEXT NOT NULL,
  jumlah     BIGINT NOT NULL CHECK (jumlah > 0),
  pihak      TEXT NOT NULL DEFAULT '',
  keterangan TEXT NOT NULL DEFAULT '',
  no_unit    TEXT NOT NULL DEFAULT '',
  ref        TEXT NOT NULL DEFAULT '',
  termin_id  BIGINT UNIQUE REFERENCES spk_termin(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kas_transaksi_tanggal_idx ON kas_transaksi (tanggal DESC);
