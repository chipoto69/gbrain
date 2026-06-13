\echo 'Rudy GBrain live database preflight'

DO $$
DECLARE
  embedding_dimensions text;
  embedding_model text;
  embedding_type text;
  empty_critical text;
BEGIN
  SELECT trim(both '"' from value::text)
    INTO embedding_dimensions
    FROM public.config
   WHERE key = 'embedding_dimensions';

  IF embedding_dimensions IS DISTINCT FROM '384' THEN
    RAISE EXCEPTION 'expected embedding_dimensions=384, got %', embedding_dimensions;
  END IF;

  SELECT trim(both '"' from value::text)
    INTO embedding_model
    FROM public.config
   WHERE key = 'embedding_model';

  IF embedding_model IS DISTINCT FROM 'openai:all-MiniLM-L6-v2' THEN
    RAISE EXCEPTION 'expected embedding_model=openai:all-MiniLM-L6-v2, got %', embedding_model;
  END IF;

  SELECT format_type(atttypid, atttypmod)
    INTO embedding_type
    FROM pg_attribute
   WHERE attrelid = 'public.content_chunks'::regclass
     AND attname = 'embedding'
     AND NOT attisdropped;

  IF embedding_type IS DISTINCT FROM 'vector(384)' THEN
    RAISE EXCEPTION 'expected public.content_chunks.embedding vector(384), got %', embedding_type;
  END IF;

  WITH critical_counts AS (
    SELECT 'pages'::text AS table_name, count(*)::bigint AS public_count FROM public.pages UNION ALL
    SELECT 'content_chunks', count(*) FROM public.content_chunks UNION ALL
    SELECT 'embedded_chunks', count(*) FROM public.content_chunks WHERE embedding IS NOT NULL UNION ALL
    SELECT 'access_tokens', count(*) FROM public.access_tokens
  )
  SELECT string_agg(table_name, ', ' ORDER BY table_name)
    INTO empty_critical
    FROM critical_counts
   WHERE public_count = 0;

  IF empty_critical IS NOT NULL THEN
    RAISE EXCEPTION 'critical live GBrain tables are empty: %', empty_critical;
  END IF;
END $$;

SELECT
  current_database() AS database_name,
  current_user AS database_user,
  current_setting('server_version') AS postgres_version,
  (SELECT value FROM public.config WHERE key = 'schema_version') AS schema_version,
  (SELECT value FROM public.config WHERE key = 'embedding_model') AS embedding_model,
  (SELECT value FROM public.config WHERE key = 'embedding_dimensions') AS embedding_dimensions,
  (SELECT count(*) FROM public.pages) AS pages,
  (SELECT count(*) FROM public.content_chunks) AS content_chunks,
  (SELECT count(*) FROM public.content_chunks WHERE embedding IS NOT NULL) AS embedded_chunks,
  (SELECT count(*) FROM public.access_tokens) AS access_tokens;
