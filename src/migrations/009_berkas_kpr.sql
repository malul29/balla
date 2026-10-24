-- Per unit: which papers are in (ticked off), the bank (KPR) stage and the next deadline.
-- Rows exist only once somebody records something; the checklist itself comes from lib/berkas.js.
CREATE TABLE berkas_units (
  no_unit     TEXT PRIMARY KEY,
  bank        TEXT NOT NULL DEFAULT '',
  kpr_tahap   TEXT NOT NULL DEFAULT 'berkas' CHECK (kpr_tahap IN ('berkas', 'pengajuan', 'analisa', 'sp3k', 'akad', 'cair', 'ditolak')),
  tenggat     DATE,
  tenggat_ket TEXT NOT NULL DEFAULT '',
  catatan     TEXT NOT NULL DEFAULT '',
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE berkas_items (
  no_unit    TEXT NOT NULL,
  kode       TEXT NOT NULL,
  selesai    BOOLEAN NOT NULL DEFAULT FALSE,
  tanggal    DATE,
  catatan    TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (no_unit, kode)
);

CREATE TABLE kpr_events (
  id         BIGSERIAL PRIMARY KEY,
  no_unit    TEXT NOT NULL,
  tahap      TEXT NOT NULL,
  tanggal    DATE NOT NULL,
  catatan    TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kpr_events_unit_idx ON kpr_events (no_unit, id);
