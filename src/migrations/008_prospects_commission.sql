-- Marketing: sales people, prospects with their follow-up history, and commission payouts.
CREATE TABLE sales_people (
  id         SERIAL PRIMARY KEY,
  nama       TEXT NOT NULL,
  telp       TEXT NOT NULL DEFAULT '',
  tipe       TEXT NOT NULL DEFAULT 'inhouse' CHECK (tipe IN ('inhouse', 'freelance', 'agen')),
  rate       NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (rate >= 0 AND rate <= 100),
  aktif      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sales_people_nama_key ON sales_people (lower(nama));

-- komisi_rate is copied from the sales person when the prospect becomes an order, so a later rate change
-- does not rewrite old deals. A unit belongs to at most one prospect at a time.
CREATE TABLE prospects (
  id          BIGSERIAL PRIMARY KEY,
  nama        TEXT NOT NULL,
  telp        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  sumber      TEXT NOT NULL DEFAULT 'lainnya',
  minat_tipe  TEXT NOT NULL DEFAULT '',
  sales_id    INTEGER REFERENCES sales_people(id) ON DELETE SET NULL,
  tahap       TEXT NOT NULL DEFAULT 'baru' CHECK (tahap IN ('baru', 'dihubungi', 'survey', 'negosiasi', 'deal', 'gagal')),
  follow_up   DATE,
  catatan     TEXT NOT NULL DEFAULT '',
  no_unit     TEXT NOT NULL DEFAULT '',
  komisi_rate NUMERIC(5,2),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX prospects_unit_key ON prospects (lower(no_unit)) WHERE no_unit <> '';
CREATE INDEX prospects_tahap_idx ON prospects (tahap);
CREATE INDEX prospects_sales_idx ON prospects (sales_id);

CREATE TABLE prospect_notes (
  id          BIGSERIAL PRIMARY KEY,
  prospect_id BIGINT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  jenis       TEXT NOT NULL DEFAULT 'catatan' CHECK (jenis IN ('telepon', 'whatsapp', 'kunjungan', 'catatan')),
  isi         TEXT NOT NULL,
  tanggal     DATE NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX prospect_notes_idx ON prospect_notes (prospect_id, id);

CREATE TABLE commission_payouts (
  id         BIGSERIAL PRIMARY KEY,
  sales_id   INTEGER NOT NULL REFERENCES sales_people(id) ON DELETE RESTRICT,
  no_unit    TEXT NOT NULL DEFAULT '',
  jumlah     BIGINT NOT NULL CHECK (jumlah > 0),
  tanggal    DATE NOT NULL,
  catatan    TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commission_payouts_sales_idx ON commission_payouts (sales_id);
