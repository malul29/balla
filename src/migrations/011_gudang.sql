-- Warehouse and materials. Stock is never edited directly: it is the sum of the movement ledger.
CREATE TABLE gudang (
  id    SERIAL PRIMARY KEY,
  nama  TEXT NOT NULL,
  aktif BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX gudang_nama_key ON gudang (lower(nama));
INSERT INTO gudang (nama) VALUES ('Gudang Utama');

-- stok_total / nilai_total: running quantity and value (moving average cost = nilai_total / stok_total).
CREATE TABLE material (
  id          SERIAL PRIMARY KEY,
  kode        TEXT NOT NULL,
  nama        TEXT NOT NULL,
  satuan      TEXT NOT NULL,
  minimum     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (minimum >= 0),
  aktif       BOOLEAN NOT NULL DEFAULT TRUE,
  stok_total  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (stok_total >= 0),
  nilai_total BIGINT NOT NULL DEFAULT 0 CHECK (nilai_total >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX material_kode_key ON material (lower(kode));

-- qty is signed (+ in, - out) per warehouse; nilai is signed rupiah at cost.
-- A transfer is two rows sharing grup (value 0). A correction points at the row it reverses (once).
CREATE TABLE stok_mutasi (
  id           BIGSERIAL PRIMARY KEY,
  tanggal      DATE NOT NULL,
  jenis        TEXT NOT NULL CHECK (jenis IN ('masuk', 'keluar', 'mutasi', 'opname', 'koreksi')),
  material_id  INTEGER NOT NULL REFERENCES material(id) ON DELETE RESTRICT,
  gudang_id    INTEGER NOT NULL REFERENCES gudang(id) ON DELETE RESTRICT,
  qty          NUMERIC(14,3) NOT NULL CHECK (qty <> 0),
  nilai        BIGINT NOT NULL DEFAULT 0,
  no_unit      TEXT NOT NULL DEFAULT '',
  ref          TEXT NOT NULL DEFAULT '',
  pihak        TEXT NOT NULL DEFAULT '',
  catatan      TEXT NOT NULL DEFAULT '',
  grup         UUID,
  koreksi_dari BIGINT REFERENCES stok_mutasi(id),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stok_mutasi_material_idx ON stok_mutasi (material_id, gudang_id);
CREATE INDEX stok_mutasi_unit_idx ON stok_mutasi (lower(no_unit)) WHERE no_unit <> '';
CREATE UNIQUE INDEX stok_mutasi_koreksi_key ON stok_mutasi (koreksi_dari) WHERE koreksi_dari IS NOT NULL;
