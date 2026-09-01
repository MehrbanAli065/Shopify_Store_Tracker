-- ============================================================
--  store_alert_mutes — an alert the user has looked at and
--  decided not to be told about again.
--
--  Some warnings are permanent facts, not problems. Clothesmentor
--  is marked partial every single day because Shopify stops paging
--  at 25,000 and its catalogue is 143,000 — nothing will ever fix
--  that, and a warning that can never be cleared trains people to
--  ignore the whole list.
--
--  Muting is per store AND per kind: silencing "this store's feed
--  comes back short" must not also silence "this store stopped
--  reporting altogether". They need different answers.
-- ============================================================
CREATE TABLE IF NOT EXISTS store_alert_mutes (
  store_id  BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind      TEXT   NOT NULL CHECK (kind IN ('partial', 'stale', 'failed')),
  note      TEXT,
  muted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, kind)
);
