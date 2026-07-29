-- ============================================================
--  Shopify Multi-Store Price & Stock Tracker
--  PostgreSQL schema — runs unchanged on PGlite and Supabase
-- ============================================================

DROP VIEW     IF EXISTS v_change_report CASCADE;
DROP FUNCTION IF EXISTS store_state_on(BIGINT, DATE) CASCADE;
DROP TABLE    IF EXISTS variant_history CASCADE;
DROP TABLE    IF EXISTS variants        CASCADE;
DROP TABLE    IF EXISTS products        CASCADE;
DROP TABLE    IF EXISTS scrape_runs     CASCADE;
DROP TABLE    IF EXISTS stores          CASCADE;


-- ─────────────────────────────────────────────
--  1 · stores    one row per Shopify store
-- ─────────────────────────────────────────────
CREATE TABLE stores (
  id               BIGINT PRIMARY KEY,          -- assigned manually: 1, 2, 3 …
  name             TEXT NOT NULL,
  domain           TEXT NOT NULL UNIQUE,
  csv_prefix       TEXT,                        -- matches the Drive filename
  country          TEXT,
  currency         TEXT DEFAULT 'PKR',
  active           BOOLEAN NOT NULL DEFAULT true,
  last_scraped_at  DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────
--  2 · scrape_runs    proof each store ran, each day
-- ─────────────────────────────────────────────
CREATE TABLE scrape_runs (
  id              BIGSERIAL PRIMARY KEY,
  store_id        BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  run_date        DATE   NOT NULL,
  status          TEXT   NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','success','failed','partial')),
  file_name       TEXT,
  rows_ingested   INT DEFAULT 0,
  products_found  INT DEFAULT 0,
  variants_found  INT DEFAULT 0,
  changes_found   INT DEFAULT 0,
  error_msg       TEXT,
  started_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  UNIQUE (store_id, run_date)                   -- one run per store per day
);


-- ─────────────────────────────────────────────
--  3 · products    handle is the identity, never the title
-- ─────────────────────────────────────────────
CREATE TABLE products (
  id             BIGSERIAL PRIMARY KEY,
  store_id       BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  handle         TEXT   NOT NULL,
  title          TEXT,
  vendor         TEXT,
  product_type   TEXT,
  tags           TEXT[],
  published_at   TIMESTAMPTZ,
  status         TEXT,
  image_src      TEXT,                           -- first image only
  first_seen_at  DATE NOT NULL,                  -- detects new products
  last_seen_at   DATE NOT NULL,                  -- detects removals
  is_active      BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (store_id, handle)
);


-- ─────────────────────────────────────────────
--  4 · variants    Layer 1 — current state (overwritten daily)
-- ─────────────────────────────────────────────
CREATE TABLE variants (
  id             BIGSERIAL PRIMARY KEY,
  product_id     BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku            TEXT,
  option1_name   TEXT, option1_value TEXT,       -- Size / Color
  option2_name   TEXT, option2_value TEXT,       -- Color / Fabric
  option3_name   TEXT, option3_value TEXT,       -- Fabric
  variant_image  TEXT,
  variant_key    TEXT NOT NULL,                  -- sku + options (SKUs are not unique)

  -- cache: rebuildable from variant_history at any time
  current_price            NUMERIC(12,2),
  current_compare_at_price NUMERIC(12,2),
  current_in_stock         BOOLEAN,
  current_discount_pct     NUMERIC(6,2) GENERATED ALWAYS AS (
                             CASE WHEN current_compare_at_price > 0
                                   AND current_compare_at_price > current_price
                                  THEN ROUND((current_compare_at_price - current_price)
                                             / current_compare_at_price * 100, 2)
                                  ELSE 0 END
                           ) STORED,

  first_seen_at  DATE NOT NULL,
  last_seen_at   DATE NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (product_id, variant_key)
);


-- ─────────────────────────────────────────────
--  5 · variant_history    Layer 2 — append-only truth
--      one row per ACTUAL change; never updated, never deleted
-- ─────────────────────────────────────────────
CREATE TABLE variant_history (
  id                BIGSERIAL PRIMARY KEY,
  variant_id        BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  scrape_run_id     BIGINT REFERENCES scrape_runs(id) ON DELETE CASCADE,
  observed_date     DATE NOT NULL,

  price             NUMERIC(12,2),
  compare_at_price  NUMERIC(12,2),
  discount_pct      NUMERIC(6,2) GENERATED ALWAYS AS (
                      CASE WHEN compare_at_price > 0 AND compare_at_price > price
                           THEN ROUND((compare_at_price - price) / compare_at_price * 100, 2)
                           ELSE 0 END
                    ) STORED,
  in_stock          BOOLEAN,

  -- previous values on the same row, so reports need no LAG()
  prev_price             NUMERIC(12,2),
  prev_compare_at_price  NUMERIC(12,2),
  prev_in_stock          BOOLEAN,

  change_type       TEXT NOT NULL
                    CHECK (change_type IN ('new','price_up','price_down',
                                           'discount_change','stock_out','stock_in','removed')),
  UNIQUE (variant_id, observed_date, change_type)
);

-- In production (Supabase) declare this PARTITION BY RANGE (observed_date)
-- and add one partition per month. Kept flat here so the same file runs locally.


-- ─────────────────────────────────────────────
--  Indexes
-- ─────────────────────────────────────────────
CREATE INDEX idx_products_store_handle  ON products (store_id, handle);
CREATE INDEX idx_products_store_first   ON products (store_id, first_seen_at);
CREATE INDEX idx_products_store_active  ON products (store_id, is_active);
CREATE INDEX idx_variants_product       ON variants (product_id);
CREATE INDEX idx_variants_active        ON variants (is_active);
CREATE INDEX idx_hist_variant_date      ON variant_history (variant_id, observed_date DESC);
CREATE INDEX idx_hist_date_type         ON variant_history (observed_date, change_type);
CREATE INDEX idx_runs_store_date        ON scrape_runs (store_id, run_date DESC);

-- Views and the store_state_on() function live in db/views.sql so they can be
-- re-applied to a live database without touching tables.
