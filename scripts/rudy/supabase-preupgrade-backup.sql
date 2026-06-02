-- Rudy GBrain pre-upgrade in-database backup.
--
-- Purpose:
--   Create copy tables for public GBrain tables before risky live schema work.
--   This is a fallback when the local Postgres password is unavailable and
--   `pg_dump` cannot be run yet.
--
-- Usage:
--   1. Replace the schema name with a fresh timestamped name.
--   2. Run as a table owner, service-role/admin session, or superuser-equivalent
--      role with full visibility into every public GBrain table. RLS-limited
--      roles can create partial backups.
--   3. Apply through Supabase SQL or `supabase migration`.
--   4. Verify row counts with scripts/rudy/supabase-readiness.sql.
--
-- This does not replace an external `pg_dump`. Take a real dump before
-- destructive changes, broad import/sync, or embedding rewrites.

CREATE SCHEMA gbrain_backup_YYYYMMDD_HHMMSS;

CREATE TABLE gbrain_backup_YYYYMMDD_HHMMSS.backup_manifest (
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
  hidden_rls_tables text;
  rls_tables text;
BEGIN
  WITH active_role AS (
    SELECT oid, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  )
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO hidden_rls_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN active_role ar
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND c.relrowsecurity
     AND NOT (ar.rolsuper OR ar.rolbypassrls OR c.relowner = ar.oid);

  IF hidden_rls_tables IS NOT NULL THEN
    RAISE EXCEPTION 'current role % may be filtered by RLS on %. Re-run backup as table owner/admin/service role before live memory work.',
      current_user,
      hidden_rls_tables;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO rls_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND c.relrowsecurity;

  IF rls_tables IS NOT NULL THEN
    RAISE NOTICE 'RLS is enabled on %. Backup is proceeding because current role owns or bypasses those tables; verify manifest counts after copy.',
      rls_tables;
  END IF;

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
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'gbrain_backup_YYYYMMDD_HHMMSS'
        AND c.relname = target_name
    ) THEN
      RAISE EXCEPTION 'backup table %.% already exists; use a fresh backup schema',
        'gbrain_backup_YYYYMMDD_HHMMSS',
        target_name;
    END IF;

    EXECUTE format(
      'CREATE TABLE %I.%I AS TABLE public.%I WITH DATA',
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
    );
  END LOOP;
END $$;
