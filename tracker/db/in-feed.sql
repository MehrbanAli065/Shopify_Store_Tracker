-- ============================================================
--  variants.in_feed — is this variant in the store's newest file?
--
--  Rebuilding a store's catalogue for a date is a DISTINCT ON over
--  its whole history, and on a 540k-variant store that is 1.6M rows
--  sorted to disk: ~26s to show 100. Almost every view is of the
--  newest day, and for that day the answer needs no history at all.
--
--  is_active could not be used: it tracks stock, not feed presence,
--  and the two are different facts the schema keeps apart on purpose.
--  last_seen_at could not either — it was wrong on 4,790 rows until
--  today, and a date is a weaker statement than a boolean anyway.
-- ============================================================
ALTER TABLE variants ADD COLUMN IF NOT EXISTS in_feed BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_variants_store_feed
  ON variants (store_id) WHERE in_feed;
