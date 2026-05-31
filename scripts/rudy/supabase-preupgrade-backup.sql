-- Rudy GBrain pre-upgrade in-database backup.
--
-- Purpose:
--   Create copy tables for public GBrain tables before risky live schema work.
--   This is a fallback when the local Postgres password is unavailable and
--   `pg_dump` cannot be run yet.
--
-- Usage:
--   1. Replace the schema name with a fresh timestamped name.
--   2. Apply through Supabase SQL or `supabase migration`.
--   3. Verify row counts with scripts/rudy/supabase-readiness.sql.
--
-- This does not replace an external `pg_dump`. Take a real dump before
-- destructive changes, broad import/sync, or embedding rewrites.

CREATE SCHEMA IF NOT EXISTS gbrain_backup_YYYYMMDD_HHMMSS;

CREATE TABLE IF NOT EXISTS gbrain_backup_YYYYMMDD_HHMMSS.backup_manifest (
  table_name text PRIMARY KEY,
  source_schema text NOT NULL DEFAULT 'public',
  source_kind text NOT NULL,
  row_count bigint NOT NULL,
  copied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  r record;
  target_name text;
  row_count bigint;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name,
           c.relkind AS relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
    ORDER BY c.relname
  LOOP
    target_name := r.table_name;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.%I AS TABLE public.%I WITH DATA',
      'gbrain_backup_YYYYMMDD_HHMMSS',
      target_name,
      r.table_name
    );
    EXECUTE format(
      'SELECT count(*) FROM %I.%I',
      'gbrain_backup_YYYYMMDD_HHMMSS',
      target_name
    )
      INTO row_count;
    INSERT INTO gbrain_backup_YYYYMMDD_HHMMSS.backup_manifest (
      table_name,
      source_kind,
      row_count
    )
    VALUES (
      r.table_name,
      CASE WHEN r.relkind = 'p' THEN 'partitioned_parent' ELSE 'table' END,
      row_count
    )
    ON CONFLICT (table_name) DO UPDATE
      SET source_kind = excluded.source_kind,
          row_count = excluded.row_count,
          copied_at = now();
  END LOOP;
END $$;
