-- ============================================================
--  Store registry — one row per Shopify store.
--  IDs are assigned manually and never change. Add stores 3–100 here.
-- ============================================================

INSERT INTO stores (id, name, domain, csv_prefix, country, currency) VALUES
  (1, 'Alkaram Studio', 'www.alkaramstudio.com', 'https___www_alkaramstudio_com', 'PK', 'PKR'),
  (2, 'Brooklinen',     'www.brooklinen.com',    'https___www_brooklinen_com',    'US', 'USD')
ON CONFLICT (id) DO UPDATE
  SET name       = EXCLUDED.name,
      domain     = EXCLUDED.domain,
      csv_prefix = EXCLUDED.csv_prefix,
      country    = EXCLUDED.country,
      currency   = EXCLUDED.currency;

-- When stores 3–100 arrive, append them here:
--   (3, 'Khaadi',   'www.khaadi.com',   'https___www_khaadi_com',   'PK', 'PKR'),
--   (4, 'Sapphire', 'pk.sapphireonline.pk', 'https___pk_sapphireonline_pk', 'PK', 'PKR'),
