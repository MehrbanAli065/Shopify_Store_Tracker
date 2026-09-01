-- ============================================================
--  store_rollup — the three counts the store list needs, kept
--  ready instead of recomputed on every page load.
--
--  Those counts cost ~19s per request: `variants` alone is 2.9 GB
--  and has to be read in full to group 4M rows by store. Nothing
--  in them changes between ingests, so the work belongs at the end
--  of an ingest, once a day, not in front of a waiting browser.
--
--  Deliberately partial: last_run, status and the scrape count stay
--  live in /api/stores. They are milliseconds to read, and a stale
--  rollup must never make a store look like it scraped today when
--  it did not.
-- ============================================================
CREATE TABLE IF NOT EXISTS store_rollup (
  store_id      BIGINT PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  products      INT NOT NULL DEFAULT 0,
  variants      INT NOT NULL DEFAULT 0,
  last_changes  INT NOT NULL DEFAULT 0,   -- changes on that store's newest run
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION refresh_store_rollup() RETURNS INT AS $$
DECLARE n INT;
BEGIN
  WITH last_run AS (
    SELECT DISTINCT ON (store_id) store_id, run_date
      FROM scrape_runs ORDER BY store_id, run_date DESC
  ), prod AS (
    SELECT store_id, count(*)::int n FROM products WHERE is_active GROUP BY 1
  ), vari AS (
    SELECT p.store_id, count(*)::int n
      FROM variants v JOIN products p ON p.id = v.product_id
     WHERE v.is_active GROUP BY 1
  ), chg AS (
    -- Only each store's newest day; the date floor lets idx_hist_date_type
    -- skip every older day rather than grinding all 8.6M history rows.
    SELECT p.store_id, count(*)::int n
      FROM variant_history h
      JOIN last_run lr ON lr.run_date = h.observed_date
      JOIN variants v ON v.id = h.variant_id
      JOIN products p ON p.id = v.product_id AND p.store_id = lr.store_id
     WHERE h.change_type <> 'new'
       AND h.observed_date >= (SELECT min(run_date) FROM last_run)
     GROUP BY 1
  )
  INSERT INTO store_rollup (store_id, products, variants, last_changes, refreshed_at)
  SELECT s.id, COALESCE(prod.n,0), COALESCE(vari.n,0), COALESCE(chg.n,0), now()
    FROM stores s
    LEFT JOIN prod ON prod.store_id = s.id
    LEFT JOIN vari ON vari.store_id = s.id
    LEFT JOIN chg  ON chg.store_id  = s.id
  ON CONFLICT (store_id) DO UPDATE
     SET products     = EXCLUDED.products,
         variants     = EXCLUDED.variants,
         last_changes = EXCLUDED.last_changes,
         refreshed_at = EXCLUDED.refreshed_at;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$ LANGUAGE plpgsql;
