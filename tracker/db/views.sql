-- ============================================================
--  Views and helper functions.
--  Kept separate from schema.sql so they can be re-applied to a
--  live database without touching tables:  npm run views
-- ============================================================

DROP VIEW     IF EXISTS v_change_report CASCADE;
DROP FUNCTION IF EXISTS store_state_on(BIGINT, DATE) CASCADE;


-- ─────────────────────────────────────────────────────────────
--  v_change_report — every change event, fully self-describing.
--
--  is_baseline marks the rows produced by a store's FIRST ingest.
--  On that run the database was empty, so every variant was
--  recorded as 'new' — that is the starting inventory, not news.
--  Anything flagged false appeared while the store was already
--  being tracked, and is genuinely new.
-- ─────────────────────────────────────────────────────────────
CREATE VIEW v_change_report AS
WITH first_run AS (
  SELECT store_id, MIN(run_date) AS first_date
    FROM scrape_runs
   WHERE status IN ('success','partial')
   GROUP BY store_id
)
SELECT
  s.id   AS store_id,
  s.name AS store_name,
  s.domain,
  s.currency,

  p.id   AS product_id,
  p.handle,
  p.title,
  p.vendor,
  p.product_type,
  p.image_src,
  'https://' || s.domain || '/products/' || p.handle AS product_url,

  v.id   AS variant_id,
  v.sku,
  NULLIF(CONCAT_WS(' / ', NULLIF(v.option1_value,''),
                          NULLIF(v.option2_value,''),
                          NULLIF(v.option3_value,'')), '') AS variant_label,

  h.observed_date,
  h.change_type,

  h.prev_price,
  h.price,
  h.price - h.prev_price AS price_diff,
  CASE WHEN h.prev_price > 0
       THEN ROUND((h.price - h.prev_price) / h.prev_price * 100, 2) END AS price_diff_pct,

  h.prev_compare_at_price,
  h.compare_at_price,
  h.discount_pct,
  CASE WHEN h.prev_compare_at_price > 0 AND h.prev_compare_at_price > h.prev_price
       THEN ROUND((h.prev_compare_at_price - h.prev_price) / h.prev_compare_at_price * 100, 2)
       ELSE 0 END AS prev_discount_pct,

  h.prev_in_stock,
  h.in_stock,
  h.in_feed,
  h.inventory_qty,

  p.first_seen_at AS product_first_seen,
  v.first_seen_at AS variant_first_seen,
  v.last_seen_at,

  -- the starting inventory, not a real arrival
  (h.change_type = 'new' AND h.observed_date = fr.first_date) AS is_baseline
FROM variant_history h
JOIN variants  v ON v.id = h.variant_id
JOIN products  p ON p.id = v.product_id
JOIN stores    s ON s.id = h.store_id
LEFT JOIN first_run fr ON fr.store_id = s.id;


-- ─────────────────────────────────────────────────────────────
--  store_state_on — the whole store as it stood on any past date
--  (carry-forward: last row on or before the date)
-- ─────────────────────────────────────────────────────────────
CREATE FUNCTION store_state_on(p_store_id BIGINT, p_date DATE)
RETURNS TABLE (
  variant_id BIGINT, handle TEXT, title TEXT, sku TEXT, variant_label TEXT,
  price NUMERIC, compare_at NUMERIC, discount_pct NUMERIC,
  in_stock BOOLEAN, changed_on DATE
) AS $$
  SELECT DISTINCT ON (h.variant_id)
         h.variant_id, p.handle, p.title, v.sku,
         NULLIF(CONCAT_WS(' / ', NULLIF(v.option1_value,''),
                                 NULLIF(v.option2_value,''),
                                 NULLIF(v.option3_value,'')), ''),
         h.price, h.compare_at_price, h.discount_pct, h.in_stock, h.observed_date
  FROM   variant_history h
  JOIN   variants v ON v.id = h.variant_id
  JOIN   products p ON p.id = v.product_id
  WHERE  h.store_id = p_store_id
    AND  h.observed_date <= p_date
  ORDER  BY h.variant_id, h.observed_date DESC;
$$ LANGUAGE sql STABLE;
