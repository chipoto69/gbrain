import { describe, expect, test } from 'bun:test';
import {
  compareToolSurface,
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

  test('extracts initialize server info', () => {
    const payloads = parseJsonRpcPayloads(JSON.stringify({
      result: { serverInfo: { name: 'gbrain', version: '0.42.1.0' } },
    }));
    expect(extractServerInfo(payloads)).toEqual({ name: 'gbrain', version: '0.42.1.0' });
  });

  test('compares core readiness separately from full local surface', () => {
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

  test('detects successful tool calls without parsing private content', () => {
    expect(hasSuccessfulToolCall([{ result: { content: [{ type: 'text', text: 'private' }] } }])).toBe(true);
    expect(hasSuccessfulToolCall([{ error: { message: 'nope' } }])).toBe(false);
  });
});
