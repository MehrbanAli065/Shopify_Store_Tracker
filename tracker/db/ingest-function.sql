-- ============================================================
--  ingest_store_day() — one store, one day, done inside the database
--
--  This is the same diff scripts/ingest.mjs performs, moved to where the
--  data already is. The point is that a caller now only has to parse a CSV
--  and hand over JSON: no caller reimplements the rules, so n8n and the
--  Node script cannot drift apart.
--
--    SELECT ingest_store_day(1, '2026-08-04', 'alkaram.csv', 8161, $payload$…$payload$::jsonb);
--
--  The payload is
--    { "products": [ {handle,title,vendor,product_type,tags[],published,status,image_src} … ],
--      "variants": [ {handle,variant_key,sku,option1_name,option1_value,…,
--                     price,compare_at,available,qty} … ] }
--
--  and it answers with a summary object:
--    {"run_id":12,"status":"success","changes":136,"new":4,"price_up":9,…}
--
--  Rules preserved from ingest.mjs, each of which was added because it
--  caught something real:
--    · replaying a day older than the newest run is refused, not merged
--    · re-running the newest day rewinds it first rather than stacking rows
--    · a feed that lost more than half its products is a failed scrape, so
--      removals are skipped and the run is marked partial
--    · a variant that left the feed and came back is 'relisted' — not 'new',
--      and not 'stock_in'
--    · a departure is recorded once, then not re-logged every night
-- ============================================================


-- Shopify's Published column is TRUE/FALSE in some exports and a timestamp in
-- others. A bad value must not take the whole run down with it.
CREATE OR REPLACE FUNCTION safe_ts (t TEXT) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF t IS NULL OR btrim(t) = '' THEN RETURN NULL; END IF;
  RETURN t::TIMESTAMPTZ;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;


CREATE OR REPLACE FUNCTION ingest_store_day (
  p_store_id      BIGINT,
  p_run_date      DATE,
  p_file_name     TEXT,
  p_rows_ingested INT,
  p_payload       JSONB
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_run_id          BIGINT;
  v_prior_run       BIGINT;
  v_newer           TEXT;
  v_db_products     INT;
  v_db_variants     INT;
  v_csv_products    INT;
  v_csv_variants    INT;
  v_first_run       BOOLEAN;
  v_allow_removals  BOOLEAN := true;
  v_changes         INT := 0;
  v_gone_products   INT := 0;
  v_status          TEXT;
  v_counts          JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stores WHERE id = p_store_id) THEN
    RAISE EXCEPTION 'store % does not exist — add it to db/seed.sql first', p_store_id;
  END IF;

  -- ── 1 · unpack the payload ───────────────────────────────────────
  DROP TABLE IF EXISTS _csv_products;
  CREATE TEMP TABLE _csv_products ON COMMIT DROP AS
  SELECT DISTINCT ON (handle) *
    FROM jsonb_to_recordset(COALESCE(p_payload->'products', '[]'::jsonb)) AS x(
      handle TEXT, title TEXT, vendor TEXT, product_type TEXT, tags TEXT[],
      published TEXT, status TEXT, image_src TEXT)
   WHERE handle IS NOT NULL AND handle <> '';

  DROP TABLE IF EXISTS _csv_variants;
  CREATE TEMP TABLE _csv_variants ON COMMIT DROP AS
  SELECT DISTINCT ON (handle, variant_key) *
    FROM jsonb_to_recordset(COALESCE(p_payload->'variants', '[]'::jsonb)) AS x(
      handle TEXT, variant_key TEXT, sku TEXT,
      option1_name TEXT, option1_value TEXT,
      option2_name TEXT, option2_value TEXT,
      option3_name TEXT, option3_value TEXT,
      variant_image TEXT,
      price NUMERIC, compare_at NUMERIC, available BOOLEAN, qty INT)
   WHERE handle IS NOT NULL AND handle <> '';

  CREATE INDEX ON _csv_products (handle);
  CREATE INDEX ON _csv_variants (handle, variant_key);

  SELECT count(*) INTO v_csv_products FROM _csv_products;
  SELECT count(*) INTO v_csv_variants FROM _csv_variants;

  IF v_csv_variants = 0 THEN
    RAISE EXCEPTION 'the payload holds no variants — refusing to ingest an empty file';
  END IF;

  -- ── 2 · refuse to replay an older day ────────────────────────────
  -- The current-state layer holds the newest values, so replaying an older
  -- day on top of it would diff against the future and write nonsense.
  SELECT id INTO v_prior_run
    FROM scrape_runs WHERE store_id = p_store_id AND run_date = p_run_date;

  SELECT string_agg(run_date::TEXT, ', ' ORDER BY run_date) INTO v_newer
    FROM scrape_runs WHERE store_id = p_store_id AND run_date > p_run_date;

  IF v_newer IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot ingest % for store %: newer runs already exist (%). Replaying an older day would corrupt the history.',
      p_run_date, p_store_id, v_newer;
  END IF;

  -- ── 3 · rewind this date if it was already ingested ──────────────
  IF v_prior_run IS NOT NULL THEN
    DELETE FROM variant_history WHERE scrape_run_id = v_prior_run;
    DELETE FROM scrape_runs     WHERE id = v_prior_run;

    UPDATE variants v
       SET current_price = h.price, current_compare_at_price = h.compare_at_price,
           current_in_stock = h.in_stock, is_active = h.in_feed,
           last_seen_at = h.observed_date, current_qty = h.inventory_qty
      FROM (SELECT DISTINCT ON (variant_id)
                   variant_id, price, compare_at_price, in_stock, in_feed,
                   inventory_qty, observed_date
              FROM variant_history
             ORDER BY variant_id, observed_date DESC, id DESC) h
     WHERE h.variant_id = v.id
       AND v.product_id IN (SELECT id FROM products WHERE store_id = p_store_id);

    -- anything whose only history was in that run never existed as far as we know
    DELETE FROM variants v USING products p
     WHERE p.id = v.product_id AND p.store_id = p_store_id
       AND NOT EXISTS (SELECT 1 FROM variant_history h WHERE h.variant_id = v.id);
    DELETE FROM products p
     WHERE p.store_id = p_store_id
       AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id);

    UPDATE products p
       SET last_seen_at = agg.seen, is_active = agg.live
      FROM (SELECT product_id, MAX(last_seen_at) AS seen, BOOL_OR(is_active) AS live
              FROM variants GROUP BY product_id) agg
     WHERE agg.product_id = p.id AND p.store_id = p_store_id;
  END IF;

  -- ── 4 · snapshot the previous state, BEFORE anything is inserted ──
  DROP TABLE IF EXISTS _db_products;
  CREATE TEMP TABLE _db_products ON COMMIT DROP AS
  SELECT id, handle, first_seen_at, is_active
    FROM products WHERE store_id = p_store_id;
  CREATE INDEX ON _db_products (handle);

  DROP TABLE IF EXISTS _db_variants;
  CREATE TEMP TABLE _db_variants ON COMMIT DROP AS
  SELECT v.id, p.handle, v.variant_key,
         v.current_price, v.current_compare_at_price, v.current_in_stock,
         -- in_feed comes from the history, never from the cache: the cache's
         -- is_active tracks stock, so it cannot answer "was this already gone".
         (SELECT h.in_feed FROM variant_history h
           WHERE h.variant_id = v.id
           ORDER BY h.observed_date DESC, h.id DESC LIMIT 1) AS last_in_feed
    FROM variants v JOIN products p ON p.id = v.product_id
   WHERE p.store_id = p_store_id;
  CREATE INDEX ON _db_variants (handle, variant_key);

  SELECT count(*) INTO v_db_products FROM _db_products;
  SELECT count(*) INTO v_db_variants FROM _db_variants;
  v_first_run := v_db_variants = 0;

  -- ── 5 · a collapsed feed is a scrape failure, not a store event ───
  IF NOT v_first_run AND v_csv_products < v_db_products * 0.5 THEN
    v_allow_removals := false;
  END IF;

  -- ── 6 · open the run ─────────────────────────────────────────────
  INSERT INTO scrape_runs (store_id, run_date, status, file_name,
                           rows_ingested, products_found, variants_found)
  VALUES (p_store_id, p_run_date, 'pending', p_file_name,
          COALESCE(p_rows_ingested, 0), v_csv_products, v_csv_variants)
  RETURNING id INTO v_run_id;

  -- ── 7 · products ─────────────────────────────────────────────────
  INSERT INTO products (store_id, handle, title, vendor, product_type, tags,
                        published_at, status, image_src,
                        first_seen_at, last_seen_at, is_active)
  SELECT p_store_id, c.handle, c.title, c.vendor, c.product_type,
         COALESCE(c.tags, '{}'), safe_ts(c.published), c.status, c.image_src,
         p_run_date, p_run_date, true
    FROM _csv_products c
   WHERE NOT EXISTS (SELECT 1 FROM _db_products d WHERE d.handle = c.handle);

  UPDATE products p
     SET last_seen_at = p_run_date, is_active = true
    FROM _csv_products c
   WHERE p.store_id = p_store_id AND p.handle = c.handle;

  -- ── 8 · variants ─────────────────────────────────────────────────
  DROP TABLE IF EXISTS _inserted;
  CREATE TEMP TABLE _inserted ON COMMIT DROP AS
  WITH ins AS (
    INSERT INTO variants (product_id, sku,
      option1_name, option1_value, option2_name, option2_value,
      option3_name, option3_value, variant_image, variant_key,
      current_price, current_compare_at_price, current_in_stock, current_qty,
      first_seen_at, last_seen_at, is_active)
    SELECT p.id, c.sku,
           c.option1_name, c.option1_value, c.option2_name, c.option2_value,
           c.option3_name, c.option3_value, c.variant_image, c.variant_key,
           c.price, c.compare_at, c.available, c.qty,
           p_run_date, p_run_date, COALESCE(c.available, true)
      FROM _csv_variants c
      JOIN products p ON p.store_id = p_store_id AND p.handle = c.handle
     WHERE NOT EXISTS (
       SELECT 1 FROM _db_variants d
        WHERE d.handle = c.handle AND d.variant_key = c.variant_key)
    RETURNING id, product_id, variant_key
  )
  SELECT ins.id, p.handle, ins.variant_key
    FROM ins JOIN products p ON p.id = ins.product_id;
  CREATE INDEX ON _inserted (handle, variant_key);

  -- ── 9 · the diff ─────────────────────────────────────────────────
  -- New variants: one 'new' row each. The cache is already correct — it was
  -- written at insert — so these do not feed the cache update below.
  INSERT INTO variant_history (variant_id, scrape_run_id, observed_date,
    price, compare_at_price, in_feed, in_stock, inventory_qty,
    prev_price, prev_compare_at_price, prev_in_stock, change_type)
  SELECT i.id, v_run_id, p_run_date,
         c.price, c.compare_at, true, c.available, c.qty,
         NULL, NULL, NULL, 'new'
    FROM _inserted i
    JOIN _csv_variants c ON c.handle = i.handle AND c.variant_key = i.variant_key;

  -- Everything that already existed and actually moved. One row per variant
  -- per day; the label follows a priority, but every value is on the row.
  DROP TABLE IF EXISTS _changed;
  CREATE TEMP TABLE _changed ON COMMIT DROP AS
  SELECT d.id AS variant_id, c.price, c.compare_at, c.available, c.qty,
         d.current_price AS prev_price,
         d.current_compare_at_price AS prev_compare,
         d.current_in_stock AS prev_in_stock,
         CASE
           -- back in the feed after being absent. Not 'new', and not
           -- 'stock_in' either: it was missing from the file, not unsellable.
           WHEN d.last_in_feed IS FALSE                     THEN 'relisted'
           WHEN d.current_in_stock IS DISTINCT FROM c.available
                THEN CASE WHEN c.available THEN 'stock_in' ELSE 'stock_out' END
           WHEN d.current_price IS DISTINCT FROM c.price
                AND abs(COALESCE(d.current_price,0) - COALESCE(c.price,0)) >= 0.005
                THEN CASE WHEN c.price > d.current_price THEN 'price_up' ELSE 'price_down' END
           ELSE 'discount_change'
         END AS change_type
    FROM _db_variants d
    JOIN _csv_variants c ON c.handle = d.handle AND c.variant_key = d.variant_key
   WHERE d.last_in_feed IS FALSE
      OR d.current_in_stock IS DISTINCT FROM c.available
      OR (d.current_price IS DISTINCT FROM c.price
          AND abs(COALESCE(d.current_price, 0) - COALESCE(c.price, 0)) >= 0.005)
      OR (d.current_compare_at_price IS DISTINCT FROM c.compare_at
          AND abs(COALESCE(d.current_compare_at_price, 0) - COALESCE(c.compare_at, 0)) >= 0.005);

  INSERT INTO variant_history (variant_id, scrape_run_id, observed_date,
    price, compare_at_price, in_feed, in_stock, inventory_qty,
    prev_price, prev_compare_at_price, prev_in_stock, change_type)
  SELECT variant_id, v_run_id, p_run_date,
         price, compare_at, true, available, qty,
         prev_price, prev_compare, prev_in_stock, change_type
    FROM _changed;

  -- ── 10 · what vanished from the feed ─────────────────────────────
  DROP TABLE IF EXISTS _gone;
  CREATE TEMP TABLE _gone ON COMMIT DROP AS
  SELECT d.id AS variant_id, d.current_price, d.current_compare_at_price,
         d.current_in_stock
    FROM _db_variants d
   WHERE v_allow_removals AND NOT v_first_run
     -- Record the departure once. The test is the last row's in_feed, not its
     -- stock: off the feed and out of stock are different facts, and without
     -- this every run re-logs the same removals for as long as it stays gone.
     AND d.last_in_feed IS DISTINCT FROM false
     AND NOT EXISTS (
       SELECT 1 FROM _csv_variants c
        WHERE c.handle = d.handle AND c.variant_key = d.variant_key);

  INSERT INTO variant_history (variant_id, scrape_run_id, observed_date,
    price, compare_at_price, in_feed, in_stock, inventory_qty,
    prev_price, prev_compare_at_price, prev_in_stock, change_type)
  SELECT variant_id, v_run_id, p_run_date,
         current_price, current_compare_at_price, false, false, NULL,
         current_price, current_compare_at_price, current_in_stock, 'removed'
    FROM _gone;

  IF v_allow_removals AND NOT v_first_run THEN
    WITH delisted AS (
      UPDATE products p SET is_active = false
       WHERE p.store_id = p_store_id AND p.is_active IS DISTINCT FROM false
         AND NOT EXISTS (SELECT 1 FROM _csv_products c WHERE c.handle = p.handle)
      RETURNING 1)
    SELECT count(*) INTO v_gone_products FROM delisted;
  END IF;

  -- ── 11 · refresh the current-state cache ─────────────────────────
  UPDATE variants v
     SET current_price = c.price, current_compare_at_price = c.compare_at,
         current_in_stock = c.available, is_active = COALESCE(c.available, true),
         current_qty = c.qty
    FROM _changed c
   WHERE v.id = c.variant_id;

  UPDATE variants v
     SET current_in_stock = false, is_active = false, current_qty = NULL
    FROM _gone g
   WHERE v.id = g.variant_id;

  UPDATE variants v
     SET last_seen_at = p_run_date
    FROM _csv_variants c
    JOIN products p ON p.store_id = p_store_id AND p.handle = c.handle
   WHERE v.product_id = p.id AND v.variant_key = c.variant_key;

  -- ── 12 · close the run ───────────────────────────────────────────
  SELECT count(*) INTO v_changes
    FROM variant_history WHERE scrape_run_id = v_run_id;

  v_status := CASE WHEN v_allow_removals THEN 'success' ELSE 'partial' END;

  UPDATE scrape_runs
     SET status = v_status, changes_found = v_changes, finished_at = now()
   WHERE id = v_run_id;
  UPDATE stores SET last_scraped_at = p_run_date WHERE id = p_store_id;

  SELECT jsonb_object_agg(change_type, n) INTO v_counts
    FROM (SELECT change_type, count(*) AS n
            FROM variant_history WHERE scrape_run_id = v_run_id
           GROUP BY change_type) t;

  RETURN jsonb_build_object(
    'run_id',           v_run_id,
    'store_id',         p_store_id,
    'run_date',         p_run_date,
    'status',           v_status,
    'first_run',        v_first_run,
    'removals_skipped', NOT v_allow_removals,
    'products_found',   v_csv_products,
    'variants_found',   v_csv_variants,
    'changes',          v_changes,
    'products_delisted', v_gone_products,
    'counts',           COALESCE(v_counts, '{}'::jsonb));
END $$;
