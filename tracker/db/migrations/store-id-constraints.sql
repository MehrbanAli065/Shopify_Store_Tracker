-- Applied after the backfill. A row without store_id is invisible to every
-- query that now filters on it, so an ingest path that forgets to set it must
-- fail loudly rather than write rows nobody can see again.
ALTER TABLE variants        ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE variant_history ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE variants
  ADD CONSTRAINT variants_store_fk FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
ALTER TABLE variant_history
  ADD CONSTRAINT variant_history_store_fk FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE;
