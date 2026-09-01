/**
 * Every SQL file a fresh database needs, in the order it must run.
 *
 * This list exists because there was no list: init-db.mjs and migrate.mjs each
 * applied schema, views and seed and nothing else, so a rebuilt database came
 * out missing four tables and eleven indexes that production had. Everything
 * added after the first week lived in a file nobody ran.
 *
 * Each file is safe to re-run — CREATE ... IF NOT EXISTS or CREATE OR REPLACE —
 * so applying the whole list to an existing database only fills in gaps.
 *
 * db/migrations/ is deliberately not here. Those are one-time steps for the
 * database as it stood before a change, kept as a record; schema.sql now
 * describes the result directly.
 */
export const SCHEMA_FILES = [
  'schema.sql',            // tables, constraints, base indexes
  'views.sql',             // the change-report view
  'rollup.sql',            // store_rollup + refresh_store_rollup()
  'day-stats.sql',         // store_day_stats + refresh_day_stats()
  'reports.sql',           // audit_reports — generated reports live in the DB
  'alerts.sql',            // store_alert_mutes — dismissed warnings
  'store-id-indexes.sql',  // the indexes the denormalised store_id makes possible
  'in-feed.sql',           // the partial index on variants.in_feed
  'seed.sql',              // the store registry — last, it needs the tables
]
