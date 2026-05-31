#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecret } from './remote-mcp-canary.ts';

const BACKUP_PLACEHOLDER = 'gbrain_backup_YYYYMMDD_HHMMSS';
const BACKUP_SCHEMA_RE = /^gbrain_backup_\d{8}_\d{6}$/;

export interface PgEnv {
  PGHOST: string;
  PGPORT?: string;
  PGDATABASE: string;
  PGUSER?: string;
  PGPASSWORD?: string;
  PGSSLMODE?: string;
}

export interface LiveActivationPlan {
  status: 'plan';
  execute_required: true;
  execution_mode: 'preflight-only' | 'backup-readiness-and-serve';
  requires_env: 'GBRAIN_DATABASE_URL';
  has_required_db_url: boolean;
  backup_schema: string;
  backup_dir: string;
  preflight_sql_file: string;
  dump_file: string;
  backup_sql_file: string;
  readiness_sql_file: string;
  commands: {
    psql_preflight: string[];
    pg_dump: string[];
    psql_backup: string[];
    psql_readiness: string[];
    local_activation: string[];
  };
  env_preview?: Partial<PgEnv>;
  warning?: string;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function backupSchemaFromDate(date = new Date()): string {
  return [
    'gbrain_backup',
    String(date.getUTCFullYear()) + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()),
    pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()),
  ].join('_');
}

export function validateBackupSchemaName(schema: string): string {
  if (!BACKUP_SCHEMA_RE.test(schema)) {
    throw new Error(`Invalid backup schema "${schema}". Expected ${BACKUP_PLACEHOLDER.replace('YYYYMMDD_HHMMSS', '<YYYYMMDD>_<HHMMSS>')}.`);
  }
  return schema;
}

export function renderSqlTemplate(template: string, backupSchema: string): string {
  validateBackupSchemaName(backupSchema);
  if (!template.includes(BACKUP_PLACEHOLDER)) {
    throw new Error(`SQL template is missing ${BACKUP_PLACEHOLDER}`);
  }
  return template.replaceAll(BACKUP_PLACEHOLDER, backupSchema);
}

export function buildReadinessAssertionSql(backupSchema: string): string {
  validateBackupSchemaName(backupSchema);
  return `
-- Rudy GBrain live activation assertions.
DO $$
DECLARE
  embedding_dimensions text;
  embedding_model text;
  embedding_type text;
  empty_critical text;
  count_mismatches text;
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

  IF to_regclass('${backupSchema}.backup_manifest') IS NULL THEN
    RAISE EXCEPTION 'missing backup manifest ${backupSchema}.backup_manifest';
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
  ),
  comparison AS (
    SELECT
      c.table_name,
      c.public_count,
      m.row_count AS backup_count
    FROM counts c
    LEFT JOIN ${backupSchema}.backup_manifest m USING (table_name)
  )
  SELECT string_agg(
           table_name || ' public=' || public_count::text || ' backup=' || coalesce(backup_count::text, 'missing'),
           '; '
           ORDER BY table_name
         )
    INTO count_mismatches
    FROM comparison
   WHERE backup_count IS NULL OR backup_count <> public_count;

  IF count_mismatches IS NOT NULL THEN
    RAISE EXCEPTION 'backup row-count mismatch: %', count_mismatches;
  END IF;
END $$;
`;
}

export function pgEnvFromDatabaseUrl(dbUrl: string): PgEnv {
  const url = new URL(dbUrl);
  if (!url.hostname) throw new Error('GBRAIN_DATABASE_URL is missing a host');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('GBRAIN_DATABASE_URL is missing a database name');
  const sslmode = url.searchParams.get('sslmode') || undefined;
  return {
    PGHOST: url.hostname,
    ...(url.port ? { PGPORT: url.port } : {}),
    PGDATABASE: database,
    ...(url.username ? { PGUSER: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
    PGSSLMODE: sslmode || 'require',
  };
}

export function redactedPgEnv(env: PgEnv): Partial<PgEnv> {
  return {
    ...env,
    ...(env.PGPASSWORD ? { PGPASSWORD: '[REDACTED]' } : {}),
  };
}

export function buildPgDumpArgs(dumpFile: string): string[] {
  return ['--format=custom', '--no-owner', '--no-acl', '--file', dumpFile];
}

export function buildPsqlArgs(sqlFile: string): string[] {
  return ['-X', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--file', sqlFile];
}

export function dbPreflightSqlFile(): string {
  return join(repoRoot(), 'scripts/rudy/supabase-db-preflight.sql');
}

export function buildLocalActivationArgs(opts: {
  port: number;
  bind: string;
  publicUrl?: string;
  claudeJson: string;
  server: string;
  timeoutMs: number;
}): string[] {
  const args = [
    'scripts/rudy/local-http-activation.ts',
    '--execute',
    '--keep-alive',
    '--port',
    String(opts.port),
    '--bind',
    opts.bind,
    '--from-claude-json',
    opts.claudeJson,
    '--server',
    opts.server,
    '--timeout-ms',
    String(opts.timeoutMs),
  ];
  if (opts.publicUrl) args.push('--public-url', opts.publicUrl);
  return args;
}

export function buildPlan(opts: {
  dbUrl?: string;
  backupSchema: string;
  backupDir: string;
  port: number;
  bind: string;
  publicUrl?: string;
  claudeJson: string;
  server: string;
  timeoutMs: number;
  preflightOnly?: boolean;
}): LiveActivationPlan {
  const schema = validateBackupSchemaName(opts.backupSchema);
  const preflightSqlFile = dbPreflightSqlFile();
  const dumpFile = join(opts.backupDir, `${schema}.dump`);
  const backupSqlFile = join(opts.backupDir, `${schema}.backup.sql`);
  const readinessSqlFile = join(opts.backupDir, `${schema}.readiness.sql`);
  return {
    status: 'plan',
    execute_required: true,
    execution_mode: opts.preflightOnly ? 'preflight-only' : 'backup-readiness-and-serve',
    requires_env: 'GBRAIN_DATABASE_URL',
    has_required_db_url: Boolean(opts.dbUrl),
    backup_schema: schema,
    backup_dir: opts.backupDir,
    preflight_sql_file: preflightSqlFile,
    dump_file: dumpFile,
    backup_sql_file: backupSqlFile,
    readiness_sql_file: readinessSqlFile,
    commands: {
      psql_preflight: ['psql', ...buildPsqlArgs(preflightSqlFile)],
      pg_dump: ['pg_dump', ...buildPgDumpArgs(dumpFile)],
      psql_backup: ['psql', ...buildPsqlArgs(backupSqlFile)],
      psql_readiness: ['psql', ...buildPsqlArgs(readinessSqlFile)],
      local_activation: ['bun', ...buildLocalActivationArgs(opts)],
    },
    ...(opts.dbUrl ? { env_preview: redactedPgEnv(pgEnvFromDatabaseUrl(opts.dbUrl)) } : {}),
    ...(!opts.dbUrl ? { warning: 'Set GBRAIN_DATABASE_URL to a valid Supabase Postgres URL before --execute. DATABASE_URL and ~/.gbrain/config.json are intentionally ignored.' } : {}),
  };
}

async function runCommand(name: string, args: string[], env: NodeJS.ProcessEnv, secrets: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(name, args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout?.on('data', chunk => {
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', chunk => {
      const text = String(chunk);
      stderr += text;
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      process.stderr.write(secrets.reduce((acc, secret) => redactSecret(acc, secret), text));
    });
    child.once('error', rejectRun);
    child.once('exit', code => {
      if (code === 0) resolveRun();
      else {
        const tail = secrets.reduce((acc, secret) => redactSecret(acc, secret), stderr.trim());
        rejectRun(new Error(`${name} exited with code ${code}${tail ? `\n--- stderr tail ---\n${tail}` : ''}`));
      }
    });
  });
}

function parseCli(argv: string[]): {
  execute: boolean;
  backupDir: string;
  backupSchema: string;
  port: number;
  bind: string;
  publicUrl?: string;
  claudeJson: string;
  server: string;
  timeoutMs: number;
  preflightOnly: boolean;
} {
  let execute = false;
  let preflightOnly = false;
  let backupDir = '/Users/rudlord/Desktop/gbrain-live-v042-activation';
  let backupSchema = backupSchemaFromDate();
  let port = 3131;
  let bind = '127.0.0.1';
  let publicUrl: string | undefined;
  let claudeJson = '/Users/rudlord/.claude.json';
  let server = 'gbrain';
  let timeoutMs = 30_000;

  const readValue = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') execute = true;
    else if (arg === '--preflight-only') preflightOnly = true;
    else if (arg === '--backup-dir') backupDir = resolve(readValue(arg, i++));
    else if (arg === '--backup-schema') backupSchema = readValue(arg, i++);
    else if (arg === '--port') port = Number(readValue(arg, i++));
    else if (arg === '--bind') bind = readValue(arg, i++);
    else if (arg === '--public-url') publicUrl = readValue(arg, i++);
    else if (arg === '--from-claude-json') claudeJson = readValue(arg, i++);
    else if (arg === '--server') server = readValue(arg, i++);
    else if (arg === '--timeout-ms') timeoutMs = Number(readValue(arg, i++));
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun scripts/rudy/live-v042-activation.ts [--execute]

Plans or runs Rudy's guarded live v0.42 activation sequence:
  1. require GBRAIN_DATABASE_URL
  2. run a read-only DB preflight
  3. write an external pg_dump
  4. create a timestamped in-database backup schema
  5. assert 384-dim readiness and backup row-count parity
  6. start local v0.42 HTTP MCP with --keep-alive

Options:
  --execute                Run the backup/readiness/activation sequence
  --preflight-only         With --execute, only verify DB auth and read-only invariants
  --backup-dir PATH        Backup output dir (default: ~/Desktop/gbrain-live-v042-activation)
  --backup-schema NAME     Override timestamped schema name
  --port N                 Local HTTP port (default: 3131)
  --bind HOST              Bind host (default: 127.0.0.1)
  --public-url URL         Optional public issuer URL for tunneled clients
  --from-claude-json PATH  Read existing bearer token from Claude JSON
  --server NAME            MCP server key in Claude JSON (default: gbrain)
  --timeout-ms N           Local activation startup/probe timeout (default: 30000)

This script intentionally ignores DATABASE_URL and ~/.gbrain/config.json.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(port) || port <= 0) throw new Error('--port must be a positive number');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
  return {
    execute,
    backupDir: resolve(backupDir),
    backupSchema: validateBackupSchemaName(backupSchema),
    port,
    bind,
    publicUrl,
    claudeJson,
    server,
    timeoutMs,
    preflightOnly,
  };
}

if (import.meta.main) {
  const secrets = [
    process.env.GBRAIN_DATABASE_URL || '',
  ].filter(Boolean);
  try {
    const cli = parseCli(process.argv.slice(2));
    const dbUrl = process.env.GBRAIN_DATABASE_URL;
    const plan = buildPlan({
      dbUrl,
      backupSchema: cli.backupSchema,
      backupDir: cli.backupDir,
      port: cli.port,
      bind: cli.bind,
      publicUrl: cli.publicUrl,
      claudeJson: cli.claudeJson,
      server: cli.server,
      timeoutMs: cli.timeoutMs,
      preflightOnly: cli.preflightOnly,
    });

    if (!cli.execute) {
      console.log(JSON.stringify(plan, null, 2));
      process.exit(dbUrl ? 0 : 1);
    }

    if (!dbUrl) {
      throw new Error('Missing GBRAIN_DATABASE_URL. Refusing to use DATABASE_URL or ~/.gbrain/config.json for live activation.');
    }

    const pgEnv = pgEnvFromDatabaseUrl(dbUrl);
    const env = {
      ...process.env,
      ...pgEnv,
    };
    await runCommand('psql', buildPsqlArgs(plan.preflight_sql_file), env, secrets);
    if (cli.preflightOnly) {
      process.exitCode = 0;
    } else {
      mkdirSync(cli.backupDir, { recursive: true });

      const root = repoRoot();
      const backupTemplate = readFileSync(join(root, 'scripts/rudy/supabase-preupgrade-backup.sql'), 'utf8');
      const readinessTemplate = readFileSync(join(root, 'scripts/rudy/supabase-readiness.sql'), 'utf8');
      writeFileSync(plan.backup_sql_file, renderSqlTemplate(backupTemplate, cli.backupSchema));
      writeFileSync(
        plan.readiness_sql_file,
        [
          renderSqlTemplate(readinessTemplate, cli.backupSchema),
          buildReadinessAssertionSql(cli.backupSchema),
        ].join('\n'),
      );

      await runCommand('pg_dump', buildPgDumpArgs(plan.dump_file), env, secrets);
      await runCommand('psql', buildPsqlArgs(plan.backup_sql_file), env, secrets);
      await runCommand('psql', buildPsqlArgs(plan.readiness_sql_file), env, secrets);
      await runCommand('bun', buildLocalActivationArgs(cli), process.env, secrets);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(secrets.reduce((acc, secret) => redactSecret(acc, secret), message));
    process.exitCode = 1;
  }
}
