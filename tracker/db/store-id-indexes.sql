-- Indexes that only become possible once store_id lives on the row.
--
-- The first one is the whole point: rebuilding a store's catalogue on a date
-- is a DISTINCT ON (variant_id) ordered by observed_date DESC, scoped to one
-- store. With this index that is an ordered index scan; without it Postgres
-- sorted 1.6M rows to disk on every request.
CREATE INDEX IF NOT EXISTS idx_hist_store_variant_date
  ON variant_history (store_id, variant_id, observed_date DESC);

-- Date-range reads: the change report and the day-by-day strip.
CREATE INDEX IF NOT EXISTS idx_hist_store_date
  ON variant_history (store_id, observed_date);

-- Counting a store's live variants no longer needs the products join.
CREATE INDEX IF NOT EXISTS idx_variants_store_active
  ON variants (store_id, is_active);

ANALYZE variant_history;
ANALYZE variants;

-- The average-discount KPI scanned every live variant of a store because the
-- percentage was not in any index: 540k heap rows, ~4s, for one number.
-- Partial and covering, so it answers from the index alone.
CREATE INDEX IF NOT EXISTS idx_variants_store_disc
  ON variants (store_id, current_discount_pct)
  WHERE is_active AND current_discount_pct > 0;

-- The discount histogram buckets every live variant, zeros included, so the
-- partial index above cannot serve it. Covering the value makes it index-only.
CREATE INDEX IF NOT EXISTS idx_variants_store_disc_all
  ON variants (store_id, current_discount_pct) WHERE is_active;

-- Price range and median, same reasoning as the discount histogram.
CREATE INDEX IF NOT EXISTS idx_variants_store_price
  ON variants (store_id, current_price) WHERE is_active;

-- The change report orders by the size of the price move, biggest first. That
-- sort key is computed, so no plain column index could serve it and Postgres
-- sorted 1.6M rows to return 100. An expression index matching the view's own
-- formula lets the ordering come straight off the index.
CREATE INDEX IF NOT EXISTS idx_hist_store_pricemove
  ON variant_history (
    store_id,
    (abs(COALESCE(CASE WHEN prev_price > 0
       THEN ROUND((price - prev_price) / prev_price * 100, 2) END, 0))) DESC,
    observed_date);
