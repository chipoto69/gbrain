#!/usr/bin/env bun

import { resolve } from 'node:path';
import {
  readClaudeMcpConfig,
  redactSecret,
  type RemoteMcpConfig,
} from './remote-mcp-canary.ts';

export const DEFAULT_REQUIRED_TOOLS = [
  'get_page',
  'put_page',
  'search',
  'query',
  'add_link',
  'add_timeline_entry',
  'get_stats',
  'get_health',
] as const;

export interface ToolSurfaceComparison {
  core_ready: boolean;
  full_surface_ready: boolean;
  remote_tool_count: number;
  local_tool_count: number;
  remote_tools: string[];
  missing_required_tools: string[];
  missing_local_tools_count: number;
  sample_missing_local_tools: string[];
}

export interface ReadinessReport extends ToolSurfaceComparison {
  status: 'full' | 'limited' | 'not_ready';
  url: string;
  source: string;
  server_name?: string;
  server_version?: string;
  stats_ok: boolean;
  health_ok: boolean;
  warning?: string;
}

interface RpcResult {
  payloads: unknown[];
  redactedText: string;
}

function normalizeToolNames(names: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(names).filter(Boolean))).sort();
}

export function parseJsonRpcPayloads(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.includes('\ndata:') || trimmed.startsWith('data:')) {
    const payloads: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const body = line.slice(5).trim();
      if (!body || body === '[DONE]') continue;
      try {
        payloads.push(JSON.parse(body));
      } catch {
        // Ignore SSE comments or non-JSON diagnostic frames.
      }
    }
    return payloads;
  }
  try {
    return [JSON.parse(trimmed)];
  } catch {
    return [];
  }
}

export function extractToolNames(payloads: unknown[]): string[] {
  const names: string[] = [];
  for (const payload of payloads) {
    const tools = (payload as any)?.result?.tools;
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      if (typeof tool?.name === 'string') names.push(tool.name);
    }
  }
  return normalizeToolNames(names);
}

export function extractNextCursor(payloads: unknown[]): string | undefined {
  for (const payload of payloads) {
    const cursor = (payload as any)?.result?.nextCursor;
    if (typeof cursor === 'string' && cursor.length > 0) return cursor;
  }
  return undefined;
}

export function extractServerInfo(payloads: unknown[]): { name?: string; version?: string } {
  for (const payload of payloads) {
    const info = (payload as any)?.result?.serverInfo;
    if (info && typeof info === 'object') {
      return {
        ...(typeof info.name === 'string' ? { name: info.name } : {}),
        ...(typeof info.version === 'string' ? { version: info.version } : {}),
      };
    }
  }
  return {};
}

export function hasSuccessfulToolCall(payloads: unknown[]): boolean {
  return payloads.some(payload => {
    const p = payload as any;
    if (p?.error) return false;
    if (p?.result?.isError === true) return false;
    return Boolean(p?.result);
  });
}

export function compareToolSurface(
  remoteTools: string[],
  localTools: string[],
  requiredTools: readonly string[] = DEFAULT_REQUIRED_TOOLS,
): ToolSurfaceComparison {
  const remote = new Set(remoteTools);
  const local = normalizeToolNames(localTools);
  const missingRequired = requiredTools.filter(name => !remote.has(name));
  const missingLocal = local.filter(name => !remote.has(name));
  return {
    core_ready: missingRequired.length === 0,
    full_surface_ready: missingLocal.length === 0 && remoteTools.length >= local.length,
    remote_tool_count: remoteTools.length,
    local_tool_count: local.length,
    remote_tools: normalizeToolNames(remoteTools),
    missing_required_tools: missingRequired,
    missing_local_tools_count: missingLocal.length,
    sample_missing_local_tools: missingLocal.slice(0, 20),
  };
}

export async function expectedRemoteToolNames(): Promise<string[]> {
  const mod = await import('../../src/core/operations.ts');
  return normalizeToolNames(
    mod.operations
      .filter((op: { localOnly?: boolean }) => !op.localOnly)
      .map((op: { name: string }) => op.name),
  );
}

async function rpcPost(
  config: RemoteMcpConfig,
  body: Record<string, unknown>,
  method: string,
  timeoutMs = 20_000,
): Promise<RpcResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = redactSecret(await res.text(), config.token);
    if (!res.ok) {
      throw new Error(`${method} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return {
      payloads: parseJsonRpcPayloads(text),
      redactedText: text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall(
  config: RemoteMcpConfig,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<RpcResult> {
  return rpcPost(config, {
    jsonrpc: '2.0',
    id,
    method,
    params,
  }, method, timeoutMs);
}

async function rpcNotify(
  config: RemoteMcpConfig,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<void> {
  await rpcPost(config, {
    jsonrpc: '2.0',
    method,
    params,
  }, method, timeoutMs);
}

async function listToolsWithPagination(
  config: RemoteMcpConfig,
  startId: number,
  timeoutMs: number,
): Promise<{ toolNames: string[]; redactedText: string; nextId: number }> {
  const toolNames: string[] = [];
  const responseTexts: string[] = [];
  let cursor: string | undefined;
  let id = startId;
  for (let page = 0; page < 50; page++) {
    const params = cursor ? { cursor } : {};
    const list = await rpcCall(config, id++, 'tools/list', params, timeoutMs);
    responseTexts.push(list.redactedText);
    toolNames.push(...extractToolNames(list.payloads));
    cursor = extractNextCursor(list.payloads);
    if (!cursor) {
      return {
        toolNames: normalizeToolNames(toolNames),
        redactedText: responseTexts.join('\n'),
        nextId: id,
      };
    }
  }
  throw new Error('tools/list pagination exceeded 50 pages');
}

export async function buildReadinessReport(
  config: RemoteMcpConfig,
  opts: { requiredTools: string[]; timeoutMs: number },
): Promise<ReadinessReport> {
  let id = 1;
  const init = await rpcCall(config, id++, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'gbrain-rudy-readiness', version: '1' },
  }, opts.timeoutMs);
  const server = extractServerInfo(init.payloads);

  await rpcNotify(config, 'notifications/initialized', {}, opts.timeoutMs).catch(() => undefined);

  const listed = await listToolsWithPagination(config, id, opts.timeoutMs);
  id = listed.nextId;
  const remoteTools = listed.toolNames;
  if (remoteTools.length === 0) {
    throw new Error(`tools/list returned no parseable tools: ${listed.redactedText.slice(0, 500)}`);
  }

  const comparison = compareToolSurface(remoteTools, await expectedRemoteToolNames(), opts.requiredTools);

  let statsOk = false;
  let healthOk = false;
  try {
    const stats = await rpcCall(config, id++, 'tools/call', {
      name: 'get_stats',
      arguments: {},
    }, opts.timeoutMs);
    statsOk = hasSuccessfulToolCall(stats.payloads);
  } catch {
    statsOk = false;
  }
  try {
    const health = await rpcCall(config, id++, 'tools/call', {
      name: 'get_health',
      arguments: {},
    }, opts.timeoutMs);
    healthOk = hasSuccessfulToolCall(health.payloads);
  } catch {
    healthOk = false;
  }

  const probesOk = statsOk && healthOk;
  const status = comparison.full_surface_ready && probesOk
    ? 'full'
    : comparison.core_ready && probesOk
      ? 'limited'
      : 'not_ready';
  return {
    status,
    url: config.url,
    source: config.source,
    ...(server.name ? { server_name: server.name } : {}),
    ...(server.version ? { server_version: server.version } : {}),
    ...comparison,
    stats_ok: statsOk,
    health_ok: healthOk,
    ...(status === 'limited'
      ? { warning: 'Remote MCP is usable for core memory ops but does not expose the full local v0.42 remote-callable tool surface.' }
      : {}),
  };
}

function tokenFromEnv(envName: string, url: string): RemoteMcpConfig {
  const token = process.env[envName];
  if (!token) throw new Error(`Missing ${envName}; pass --from-claude-json or set ${envName}`);
  return { url, token, source: `env:${envName}` };
}

function parseCli(argv: string[]): {
  config: RemoteMcpConfig;
  requiredTools: string[];
  timeoutMs: number;
  strictFullSurface: boolean;
} {
  let url = '';
  let tokenEnv = 'GBRAIN_MCP_TOKEN';
  let claudeJson = '';
  let server = 'gbrain';
  let timeoutMs = 20_000;
  const requiredTools: string[] = [...DEFAULT_REQUIRED_TOOLS];
  let strictFullSurface = false;

  const readValue = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') url = readValue(arg, i++);
    else if (arg === '--token-env') tokenEnv = readValue(arg, i++);
    else if (arg === '--from-claude-json') claudeJson = readValue(arg, i++);
    else if (arg === '--server') server = readValue(arg, i++);
    else if (arg === '--timeout-ms') timeoutMs = Number(readValue(arg, i++));
    else if (arg === '--require-tool') requiredTools.push(readValue(arg, i++));
    else if (arg === '--strict-full-surface') strictFullSurface = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun scripts/rudy/remote-mcp-readiness.ts [--from-claude-json PATH] [--server gbrain]

Reports whether the configured remote GBrain MCP is ready for architecture
integration without printing bearer tokens.

Options:
  --from-claude-json PATH  Read mcpServers.<server>.url and Authorization
  --server NAME            MCP server key in Claude JSON (default: gbrain)
  --url URL                MCP URL when using an env token
  --token-env NAME         Env var containing bearer token (default: GBRAIN_MCP_TOKEN)
  --require-tool NAME      Add a required tool to the core readiness gate
  --strict-full-surface    Exit non-zero unless remote exposes every local HTTP-safe tool
  --timeout-ms N           Per-request timeout (default: 20000)`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
  const config = claudeJson
    ? readClaudeMcpConfig(resolve(claudeJson), server)
    : tokenFromEnv(tokenEnv, url);
  if (!config.url) throw new Error('--url is required unless --from-claude-json is used');
  return { config, requiredTools, timeoutMs, strictFullSurface };
}

if (import.meta.main) {
  try {
    const opts = parseCli(process.argv.slice(2));
    const report = await buildReadinessReport(opts.config, opts);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'not_ready') process.exit(1);
    if (opts.strictFullSurface && !report.full_surface_ready) process.exit(2);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
