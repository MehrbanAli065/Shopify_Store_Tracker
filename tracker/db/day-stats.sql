-- ============================================================
--  store_day_stats — one row per store per day, holding the
--  change counts the report page asks for.
--
--  Those counts came from scanning variant_history on every page
--  load. For a 540k-variant store that is 2.9M rows per request to
--  produce eleven integers, and it cost ~19s. The numbers only
--  change when an ingest runs, so they are computed once there.
--
--  Same contract as store_rollup: a cache, never the source of
--  truth. variant_history remains the record; this is derived and
--  can be rebuilt from it at any time.
-- ============================================================
CREATE TABLE IF NOT EXISTS store_day_stats (
  store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  observed_date   DATE   NOT NULL,
  new_items       INT NOT NULL DEFAULT 0,   -- excludes the first run's baseline
  baseline_items  INT NOT NULL DEFAULT 0,   -- the first run's starting inventory
  price_up        INT NOT NULL DEFAULT 0,
  price_down      INT NOT NULL DEFAULT 0,
  discount_change INT NOT NULL DEFAULT 0,
  stock_out       INT NOT NULL DEFAULT 0,
  stock_in        INT NOT NULL DEFAULT 0,
  removed         INT NOT NULL DEFAULT 0,
  relisted        INT NOT NULL DEFAULT 0,
  total           INT NOT NULL DEFAULT 0,   -- everything except baseline
  PRIMARY KEY (store_id, observed_date)
);

/** Recomputes one store-day, or every day of a store when p_date IS NULL. */
CREATE OR REPLACE FUNCTION refresh_day_stats(p_store_id BIGINT, p_date DATE DEFAULT NULL)
RETURNS INT AS $$
DECLARE n INT;
BEGIN
  DELETE FROM store_day_stats
   WHERE store_id = p_store_id AND (p_date IS NULL OR observed_date = p_date);

  INSERT INTO store_day_stats
  SELECT h.store_id, h.observed_date,
    count(*) FILTER (WHERE h.change_type = 'new' AND h.observed_date <> fr.first_date)::int,
    count(*) FILTER (WHERE h.change_type = 'new' AND h.observed_date  = fr.first_date)::int,
    count(*) FILTER (WHERE h.change_type = 'price_up')::int,
    count(*) FILTER (WHERE h.change_type = 'price_down')::int,
    count(*) FILTER (WHERE h.change_type = 'discount_change')::int,
    count(*) FILTER (WHERE h.change_type = 'stock_out')::int,
    count(*) FILTER (WHERE h.change_type = 'stock_in')::int,
    count(*) FILTER (WHERE h.change_type = 'removed')::int,
    count(*) FILTER (WHERE h.change_type = 'relisted')::int,
    count(*) FILTER (WHERE NOT (h.change_type = 'new' AND h.observed_date = fr.first_date))::int
    FROM variant_history h
    LEFT JOIN (SELECT store_id, MIN(run_date) AS first_date FROM scrape_runs
                WHERE status IN ('success','partial') GROUP BY store_id) fr
           ON fr.store_id = h.store_id
   WHERE h.store_id = p_store_id AND (p_date IS NULL OR h.observed_date = p_date)
   GROUP BY h.store_id, h.observed_date;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$ LANGUAGE plpgsql;
