-- Rudy GBrain live readiness probes.
--
-- Run these through Supabase SQL or psql before/after live upgrade work.
-- Keep outputs redacted in public logs; row counts and schema markers are OK.

-- Project-level GBrain config markers.
SELECT key, value
FROM public.config
WHERE key IN ('schema_version', 'embedding_model', 'embedding_dimensions')
ORDER BY key;

-- Embedding column width. The live Rudy brain must remain vector(384).
SELECT
  attname AS column_name,
  format_type(atttypid, atttypmod) AS column_type
FROM pg_attribute
WHERE attrelid = 'public.content_chunks'::regclass
  AND attname = 'embedding'
  AND NOT attisdropped;

-- Memory-critical row counts.
WITH counts AS (
  SELECT 'pages'::text AS table_name, count(*)::bigint AS public_count FROM public.pages UNION ALL
  SELECT 'content_chunks', count(*) FROM public.content_chunks UNION ALL
  SELECT 'embedded_chunks', count(*) FROM public.content_chunks WHERE embedding IS NOT NULL UNION ALL
  SELECT 'links', count(*) FROM public.links UNION ALL
  SELECT 'tags', count(*) FROM public.tags UNION ALL
  SELECT 'timeline_entries', count(*) FROM public.timeline_entries UNION ALL
  SELECT 'raw_data', count(*) FROM public.raw_data UNION ALL
  SELECT 'ingest_log', count(*) FROM public.ingest_log UNION ALL
  SELECT 'page_versions', count(*) FROM public.page_versions UNION ALL
  SELECT 'access_tokens', count(*) FROM public.access_tokens UNION ALL
  SELECT 'mcp_request_log', count(*) FROM public.mcp_request_log UNION ALL
  SELECT 'oauth_clients', count(*) FROM public.oauth_clients
)
SELECT *
FROM counts
ORDER BY table_name;

-- Compare public row counts against a timestamped backup schema.
-- Replace gbrain_backup_YYYYMMDD_HHMMSS with the actual backup schema.
WITH counts AS (
  SELECT 'pages'::text AS table_name, count(*)::bigint AS public_count FROM public.pages UNION ALL
  SELECT 'content_chunks', count(*) FROM public.content_chunks UNION ALL
  SELECT 'links', count(*) FROM public.links UNION ALL
  SELECT 'tags', count(*) FROM public.tags UNION ALL
  SELECT 'timeline_entries', count(*) FROM public.timeline_entries UNION ALL
  SELECT 'raw_data', count(*) FROM public.raw_data UNION ALL
  SELECT 'ingest_log', count(*) FROM public.ingest_log UNION ALL
  SELECT 'page_versions', count(*) FROM public.page_versions UNION ALL
  SELECT 'access_tokens', count(*) FROM public.access_tokens UNION ALL
  SELECT 'mcp_request_log', count(*) FROM public.mcp_request_log UNION ALL
  SELECT 'oauth_clients', count(*) FROM public.oauth_clients
)
SELECT
  c.table_name,
  c.public_count,
  m.row_count AS backup_count,
  c.public_count = m.row_count AS matches
FROM counts c
LEFT JOIN gbrain_backup_YYYYMMDD_HHMMSS.backup_manifest m USING (table_name)
ORDER BY c.table_name;
