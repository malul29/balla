-- Construction progress per unit (the house exists whether or not it is sold), site photos, punch list, handover.
CREATE TABLE progres_units (
  no_unit    TEXT NOT NULL,
  kode       TEXT NOT NULL,
  persen     SMALLINT NOT NULL DEFAULT 0 CHECK (persen BETWEEN 0 AND 100),
  catatan    TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (no_unit, kode)
);

CREATE TABLE progres_foto (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  no_unit    TEXT NOT NULL,
  kode       TEXT NOT NULL DEFAULT '',
  tanggal    DATE NOT NULL,
  keterangan TEXT NOT NULL DEFAULT '',
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX progres_foto_unit_idx ON progres_foto (lower(no_unit), created_at DESC);

CREATE TABLE punch_items (
  id              BIGSERIAL PRIMARY KEY,
  no_unit         TEXT NOT NULL,
  ruang           TEXT NOT NULL DEFAULT '',
  uraian          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'selesai')),
  selesai_tanggal DATE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX punch_items_unit_idx ON punch_items (lower(no_unit), id);

-- Berita Acara Serah Terima: one per order (cleared with it when an order is cancelled).
CREATE TABLE handovers (
  no_unit         TEXT PRIMARY KEY,
  no_bast         TEXT NOT NULL UNIQUE,
  tanggal         DATE NOT NULL,
  penerima        TEXT NOT NULL,
  catatan         TEXT NOT NULL DEFAULT '',
  tanggal_acuan   DATE,
  sisa_pekerjaan  BIGINT NOT NULL DEFAULT 0,
  dipaksa         BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
