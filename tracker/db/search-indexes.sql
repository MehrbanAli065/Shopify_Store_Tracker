-- ============================================================
--  Trigram indexes for the product finder.
--
--  The change log's search used to filter the rows already on screen, so a
--  product could only be found if it happened to be on the current page. It
--  now searches the products table directly, and that means ILIKE '%…%' —
--  which no btree index can help with. Across 708,000 products a scan of one
--  store cost 150–900 ms per keystroke.
--
--  pg_trgm indexes the three-character sequences of a string, so a substring
--  match becomes an index lookup: the same searches come back in 5–30 ms, and
--  the worst case (a term matching most of a large store's catalogue, where
--  the sort dominates) drops from 900 ms to under 600 ms.
--
--  Guarded, because CREATE EXTENSION needs privileges the app's role may not
--  have on a managed database. Without the extension the finder still works —
--  it falls back to the scan it does today — so a database that cannot create
--  it is degraded, not broken.
--
--  Idempotent:  npm run search:init
-- ============================================================

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR undefined_object THEN
  RAISE NOTICE 'pg_trgm not available — product search falls back to a table scan';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_products_title_trgm
      ON products USING gin (title  gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_products_handle_trgm
      ON products USING gin (handle gin_trgm_ops);
  END IF;
END $$;
