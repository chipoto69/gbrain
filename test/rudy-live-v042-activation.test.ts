import { describe, expect, test } from 'bun:test';
import {
  backupSchemaFromDate,
  buildLocalActivationArgs,
  buildPlan,
  buildReadinessAssertionSql,
  pgEnvFromDatabaseUrl,
  renderSqlTemplate,
  validateBackupSchemaName,
} from '../scripts/rudy/live-v042-activation.ts';

describe('rudy live v0.42 activation', () => {
  test('builds timestamped backup schema names', () => {
    expect(backupSchemaFromDate(new Date(Date.UTC(2026, 4, 31, 21, 44, 13))))
      .toBe('gbrain_backup_20260531_214413');
  });

  test('validates backup schema names', () => {
    expect(validateBackupSchemaName('gbrain_backup_20260531_214413')).toBe('gbrain_backup_20260531_214413');
    expect(() => validateBackupSchemaName('public;drop schema public')).toThrow('Invalid backup schema');
  });

  test('renders SQL templates with the validated backup schema', () => {
    const sql = renderSqlTemplate(
      'CREATE SCHEMA gbrain_backup_YYYYMMDD_HHMMSS; SELECT * FROM gbrain_backup_YYYYMMDD_HHMMSS.backup_manifest;',
      'gbrain_backup_20260531_214413',
    );
    expect(sql).toContain('CREATE SCHEMA gbrain_backup_20260531_214413');
    expect(sql).not.toContain('YYYYMMDD');
  });

  test('parses database URL into pg env without requiring argv secrets', () => {
    const env = pgEnvFromDatabaseUrl('postgresql://postgres.ref:p%40ss@aws-0.example.pooler.supabase.com:6543/postgres?sslmode=require');
    expect(env).toEqual({
      PGHOST: 'aws-0.example.pooler.supabase.com',
      PGPORT: '6543',
      PGDATABASE: 'postgres',
      PGUSER: 'postgres.ref',
      PGPASSWORD: 'p@ss',
      PGSSLMODE: 'require',
    });
  });

  test('plans without leaking database URL credentials', () => {
    const plan = buildPlan({
      dbUrl: 'postgresql://postgres:secret@example.com:6543/postgres?sslmode=require',
      backupSchema: 'gbrain_backup_20260531_214413',
      backupDir: '/tmp/gbrain-backup',
      port: 3131,
      bind: '127.0.0.1',
      claudeJson: '/Users/rudlord/.claude.json',
      server: 'gbrain',
      timeoutMs: 30_000,
    });
    expect(plan.has_required_db_url).toBe(true);
    expect(plan.env_preview?.PGPASSWORD).toBe('[REDACTED]');
    expect(JSON.stringify(plan.commands)).not.toContain('secret');
    expect(plan.commands.local_activation).toContain('--keep-alive');
  });

  test('warns when the required GBRAIN_DATABASE_URL is absent', () => {
    const plan = buildPlan({
      backupSchema: 'gbrain_backup_20260531_214413',
      backupDir: '/tmp/gbrain-backup',
      port: 3131,
      bind: '127.0.0.1',
      claudeJson: '/Users/rudlord/.claude.json',
      server: 'gbrain',
      timeoutMs: 30_000,
    });
    expect(plan.has_required_db_url).toBe(false);
    expect(plan.warning).toContain('GBRAIN_DATABASE_URL');
  });

  test('readiness assertion pins 384-dimensional live memory invariants', () => {
    const sql = buildReadinessAssertionSql('gbrain_backup_20260531_214413');
    expect(sql).toContain('embedding_dimensions');
    expect(sql).toContain('openai:all-MiniLM-L6-v2');
    expect(sql).toContain('vector(384)');
    expect(sql).toContain('gbrain_backup_20260531_214413.backup_manifest');
  });

  test('local activation args delegate to keep-alive activation gate', () => {
    expect(buildLocalActivationArgs({
      port: 3131,
      bind: '127.0.0.1',
      claudeJson: '/Users/rudlord/.claude.json',
      server: 'gbrain',
      timeoutMs: 30_000,
    })).toEqual([
      'scripts/rudy/local-http-activation.ts',
      '--execute',
      '--keep-alive',
      '--port',
      '3131',
      '--bind',
      '127.0.0.1',
      '--from-claude-json',
      '/Users/rudlord/.claude.json',
      '--server',
      'gbrain',
      '--timeout-ms',
      '30000',
    ]);
  });
});
