-- ============================================================
--  Generated audit reports.
--
--  Vercel's filesystem is read-only, so a generated report cannot be
--  written to disk and linked. The rendered HTML lives here instead, which
--  also means a link stays openable long after the run that produced it —
--  and the inputs are kept beside it so any past report can be explained.
--
--  Re-appliable on its own:  node scripts/apply-reports.mjs
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_reports (
  id            TEXT PRIMARY KEY,                 -- short url-safe token
  store_id      BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  from_date     DATE NOT NULL,                    -- T0 start, as actually used
  to_date       DATE NOT NULL,                    -- T0 end
  doc_no        TEXT NOT NULL,                    -- printed on the cover

  -- The facts the audit was built from, exactly as computed. Kept so a number
  -- in an old report can be traced back without re-running the engine against
  -- data that has since moved on.
  facts         JSONB NOT NULL,
  -- What the model wrote, separately, so a re-word never touches the facts.
  narrative     JSONB,

  html          TEXT NOT NULL,
  model         TEXT,                             -- which model wrote the prose
  prompt_tokens INT,
  output_tokens INT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_ms  INT
);

CREATE INDEX IF NOT EXISTS idx_audit_store_date
  ON audit_reports (store_id, generated_at DESC);
