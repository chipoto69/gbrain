import { describe, expect, test } from 'bun:test';
import {
  buildReadinessReport,
  compareToolSurface,
  DEFAULT_REQUIRED_TOOLS,
  expectedRemoteToolNames,
  extractNextCursor,
  extractServerInfo,
  extractToolNames,
  hasSuccessfulToolCall,
  parseJsonRpcPayloads,
} from '../scripts/rudy/remote-mcp-readiness.ts';

describe('rudy remote MCP readiness', () => {
  test('parses JSON tools/list responses', () => {
    const payloads = parseJsonRpcPayloads(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          { name: 'search' },
          { name: 'get_page' },
        ],
      },
    }));
    expect(extractToolNames(payloads)).toEqual(['get_page', 'search']);
  });

  test('parses SSE tools/list responses', () => {
    const text = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"query"},{"name":"get_stats"}]}}',
      '',
    ].join('\n');
    expect(extractToolNames(parseJsonRpcPayloads(text))).toEqual(['get_stats', 'query']);
  });

  test('extracts tools/list pagination cursors', () => {
    const payloads = parseJsonRpcPayloads(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [{ name: 'search' }],
        nextCursor: 'next-page',
      },
    }));
    expect(extractNextCursor(payloads)).toBe('next-page');
  });

  test('extracts initialize server info', () => {
    const payloads = parseJsonRpcPayloads(JSON.stringify({
      result: { serverInfo: { name: 'gbrain', version: '0.42.1.0' } },
    }));
    expect(extractServerInfo(payloads)).toEqual({ name: 'gbrain', version: '0.42.1.0' });
  });

  test('compares core readiness separately from full remote-callable surface', () => {
    const remote = ['get_page', 'put_page', 'search', 'query', 'add_timeline_entry', 'get_stats', 'get_health'];
    const local = [...remote, 'run_skillopt', 'code_def'];
    const got = compareToolSurface(remote, local, ['get_page', 'search', 'query', 'get_stats']);
    expect(got.core_ready).toBe(true);
    expect(got.full_surface_ready).toBe(false);
    expect(got.missing_local_tools_count).toBe(2);
    expect(got.sample_missing_local_tools).toEqual(['code_def', 'run_skillopt']);
  });

  test('reports missing required tools', () => {
    const got = compareToolSurface(['get_page'], ['get_page', 'search'], ['get_page', 'search']);
    expect(got.core_ready).toBe(false);
    expect(got.missing_required_tools).toEqual(['search']);
  });

  test('expected remote surface excludes host-only operations', async () => {
    const names = await expectedRemoteToolNames();
    expect(names).toContain('put_page');
    expect(names).not.toContain('sync_brain');
    expect(names).not.toContain('file_list');
    expect(names).not.toContain('get_recent_transcripts');
  });

  test('detects successful tool calls without parsing private content', () => {
    expect(hasSuccessfulToolCall([{ result: { content: [{ type: 'text', text: 'private' }] } }])).toBe(true);
    expect(hasSuccessfulToolCall([{ error: { message: 'nope' } }])).toBe(false);
    expect(hasSuccessfulToolCall([{ result: { isError: true, content: [{ type: 'text', text: 'failed' }] } }])).toBe(false);
  });

  test('sends initialized notification and follows tools/list pagination', async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push(body);
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            serverInfo: { name: 'gbrain', version: '0.42.1.0' },
            capabilities: { tools: {} },
          },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 204 });
      }
      if (body.method === 'tools/list' && !body.params?.cursor) {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              { name: 'get_page' },
              { name: 'put_page' },
              { name: 'search' },
              { name: 'query' },
            ],
            nextCursor: 'page-2',
          },
        });
      }
      if (body.method === 'tools/list' && body.params?.cursor === 'page-2') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              { name: 'add_link' },
              { name: 'add_timeline_entry' },
              { name: 'get_stats' },
              { name: 'get_health' },
            ],
          },
        });
      }
      if (body.method === 'tools/call') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: '{}' }] },
        });
      }
      return Response.json({ error: { message: 'unexpected' } }, { status: 500 });
    }) as typeof fetch;

    try {
      const report = await buildReadinessReport(
        { url: 'https://example.invalid/mcp', token: 'secret', source: 'test' },
        { requiredTools: [...DEFAULT_REQUIRED_TOOLS], timeoutMs: 1_000 },
      );
      expect(report.core_ready).toBe(true);
      expect(report.stats_ok).toBe(true);
      expect(report.health_ok).toBe(true);
      expect(report.write_probe_required).toBe(true);
      expect(report.write_probe_ok).toBe(true);
      expect(calls.map((call: any) => call.method)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/list',
        'tools/call',
        'tools/call',
        'tools/call',
      ]);
      expect((calls[3] as any).params).toEqual({ cursor: 'page-2' });
      expect((calls[6] as any).params).toMatchObject({
        name: 'put_page',
        arguments: { dry_run: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not report full readiness when a required probe returns an MCP error result', async () => {
    const originalFetch = globalThis.fetch;
    const tools = (await expectedRemoteToolNames()).map(name => ({ name }));
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            serverInfo: { name: 'gbrain', version: '0.42.1.0' },
            capabilities: { tools: {} },
          },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 204 });
      }
      if (body.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools },
        });
      }
      if (body.method === 'tools/call' && body.params?.name === 'get_stats') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: '{}' }] },
        });
      }
      if (body.method === 'tools/call' && body.params?.name === 'get_health') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { isError: true, content: [{ type: 'text', text: 'unhealthy' }] },
        });
      }
      return Response.json({ error: { message: 'unexpected' } }, { status: 500 });
    }) as typeof fetch;

    try {
      const report = await buildReadinessReport(
        { url: 'https://example.invalid/mcp', token: 'secret', source: 'test' },
        { requiredTools: [...DEFAULT_REQUIRED_TOOLS], timeoutMs: 1_000 },
      );
      expect(report.full_surface_ready).toBe(true);
      expect(report.stats_ok).toBe(true);
      expect(report.health_ok).toBe(false);
      expect(report.status).toBe('not_ready');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not report ready when the dry-run write-scope probe is rejected', async () => {
    const originalFetch = globalThis.fetch;
    const tools = (await expectedRemoteToolNames()).map(name => ({ name }));
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            serverInfo: { name: 'gbrain', version: '0.42.1.0' },
            capabilities: { tools: {} },
          },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 204 });
      }
      if (body.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools },
        });
      }
      if (body.method === 'tools/call' && (body.params?.name === 'get_stats' || body.params?.name === 'get_health')) {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: '{}' }] },
        });
      }
      if (body.method === 'tools/call' && body.params?.name === 'put_page') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: '{"error":"insufficient_scope"}' }],
          },
        });
      }
      return Response.json({ error: { message: 'unexpected' } }, { status: 500 });
    }) as typeof fetch;

    try {
      const report = await buildReadinessReport(
        { url: 'https://example.invalid/mcp', token: 'secret', source: 'test' },
        { requiredTools: [...DEFAULT_REQUIRED_TOOLS], timeoutMs: 1_000 },
      );
      expect(report.full_surface_ready).toBe(true);
      expect(report.stats_ok).toBe(true);
      expect(report.health_ok).toBe(true);
      expect(report.write_probe_required).toBe(true);
      expect(report.write_probe_ok).toBe(false);
      expect(report.status).toBe('not_ready');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
