-- ============================================================
--  'relisted' — a variant that left the feed and came back.
--
--  Without it there is no honest label for the transition. 'new' is false
--  (the variant is not new, and it would inflate the new-products count with
--  returns) and 'stock_in' is false too (it was not restocked, it was absent
--  from the file altogether). The schema already insists in_feed and in_stock
--  are different facts; this is the change type that keeps them that way.
--
--  Additive and idempotent:  node scripts/apply-relisted.mjs
-- ============================================================

ALTER TABLE variant_history DROP CONSTRAINT IF EXISTS variant_history_change_type_check;

ALTER TABLE variant_history ADD CONSTRAINT variant_history_change_type_check
  CHECK (change_type IN ('new','price_up','price_down','discount_change',
                         'stock_out','stock_in','removed','relisted'));
