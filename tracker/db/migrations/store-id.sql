-- ============================================================
--  store_id on variants and variant_history
--
--  Every store-scoped read had to walk variant_history -> variants
--  -> products just to learn which store a row belonged to. On a
--  540k-variant store that is a 1.6M-row join sorted to disk, and
--  it made one archived day cost 54s to show 100 rows.
--
--  The column is denormalised on purpose: it never changes for a
--  row (a variant cannot move to another store), so there is no
--  update anomaly to guard against — only the write path has to
--  set it, which ingest.mjs now does.
-- ============================================================
ALTER TABLE variants        ADD COLUMN IF NOT EXISTS store_id BIGINT;
ALTER TABLE variant_history ADD COLUMN IF NOT EXISTS store_id BIGINT;
