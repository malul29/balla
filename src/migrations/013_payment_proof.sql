-- Surat Pemesanan may keep an image of the buyer's payment proof.
ALTER TABLE uploads DROP CONSTRAINT uploads_kind_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_kind_check
  CHECK (kind IN ('ktp', 'npwp', 'bukti', 'kk', 'rekening', 'nikah'));
