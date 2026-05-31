import { describe, expect, test } from 'bun:test';
import {
  buildPlan,
  buildServeArgs,
  dbUrlSource,
  localMcpUrl,
  redactDbUrl,
} from '../scripts/rudy/local-http-activation.ts';

describe('rudy local HTTP activation', () => {
  test('redacts database URL credentials', () => {
    expect(redactDbUrl('postgresql://user:pass@example.com:6543/postgres?sslmode=require'))
      .toBe('postgresql://%5BUSER%5D:%5BREDACTED%5D@example.com:6543/postgres?sslmode=require');
    expect(redactDbUrl('not a url')).toBe('[REDACTED_DB_URL]');
  });

  test('resolves DB URL source precedence', () => {
    expect(dbUrlSource({ GBRAIN_DATABASE_URL: 'x', DATABASE_URL: 'y' }, true)).toBe('env:GBRAIN_DATABASE_URL');
    expect(dbUrlSource({ DATABASE_URL: 'y' }, true)).toBe('env:DATABASE_URL');
    expect(dbUrlSource({}, true)).toBe('config-file');
    expect(dbUrlSource({}, false)).toBe('missing');
  });

  test('builds loopback MCP URL for wildcard binds', () => {
    expect(localMcpUrl(3131, '0.0.0.0')).toBe('http://127.0.0.1:3131/mcp');
    expect(localMcpUrl(3131, '127.0.0.1')).toBe('http://127.0.0.1:3131/mcp');
    expect(localMcpUrl(3131, '::1')).toBe('http://[::1]:3131/mcp');
  });

  test('builds serve args with safe defaults', () => {
    expect(buildServeArgs({ port: 3131, bind: '127.0.0.1' })).toEqual([
      'run',
      'src/cli.ts',
      'serve',
      '--http',
      '--port',
      '3131',
      '--bind',
      '127.0.0.1',
      '--suppress-bootstrap-token',
    ]);
  });

  test('builds a non-mutating activation plan', () => {
    const plan = buildPlan({
      port: 3131,
      bind: '127.0.0.1',
      dbUrlSource: 'config-file',
      hasDbUrl: true,
    });
    expect(plan.status).toBe('plan');
    expect(plan.execute_required).toBe(true);
    expect(plan.mcp_url).toBe('http://127.0.0.1:3131/mcp');
    expect(plan.readiness_gate).toContain('--strict-full-surface');
    expect(plan.warning).toContain('Prefer GBRAIN_DATABASE_URL');
  });
});
