-- SKU and SPU may keep a PDF or image describing the buyer's work status.
ALTER TABLE uploads DROP CONSTRAINT uploads_kind_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_kind_check
  CHECK (kind IN ('ktp', 'npwp', 'bukti', 'pekerjaan', 'kk', 'rekening', 'nikah'));
