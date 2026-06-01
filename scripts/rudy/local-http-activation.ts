#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { readClaudeMcpConfig, redactSecret, type RemoteMcpConfig } from './remote-mcp-canary.ts';
import { buildReadinessReport, DEFAULT_REQUIRED_TOOLS } from './remote-mcp-readiness.ts';

export type DbUrlSource = 'env:GBRAIN_DATABASE_URL' | 'env:DATABASE_URL' | 'config-file' | 'missing';

export interface LocalActivationPlan {
  status: 'plan';
  execute_required: true;
  execution_mode: 'verify-and-stop' | 'keep-alive';
  db_url_source: DbUrlSource;
  has_db_url: boolean;
  mcp_url: string;
  serve_args: string[];
  readiness_gate: string;
  warning?: string;
}

export function redactDbUrl(input: string | undefined): string | undefined {
  if (!input) return input;
  try {
    const url = new URL(input);
    if (url.password) url.password = '[REDACTED]';
    if (url.username) url.username = '[USER]';
    return url.toString();
  } catch {
    return '[REDACTED_DB_URL]';
  }
}

export function dbUrlSource(env: NodeJS.ProcessEnv, hasConfigFileUrl: boolean): DbUrlSource {
  if (env.GBRAIN_DATABASE_URL) return 'env:GBRAIN_DATABASE_URL';
  if (env.DATABASE_URL) return 'env:DATABASE_URL';
  if (hasConfigFileUrl) return 'config-file';
  return 'missing';
}

export function buildServeArgs(opts: {
  port: number;
  bind: string;
  publicUrl?: string;
  suppressBootstrapToken?: boolean;
}): string[] {
  const args = ['run', 'src/cli.ts', 'serve', '--http', '--port', String(opts.port), '--bind', opts.bind];
  if (opts.publicUrl) args.push('--public-url', opts.publicUrl);
  if (opts.suppressBootstrapToken ?? true) args.push('--suppress-bootstrap-token');
  return args;
}

export function localMcpUrl(port: number, bind: string): string {
  const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketed}:${port}/mcp`;
}

export function buildPlan(opts: {
  port: number;
  bind: string;
  publicUrl?: string;
  dbUrlSource: DbUrlSource;
  hasDbUrl: boolean;
  keepAlive?: boolean;
}): LocalActivationPlan {
  const mcpUrl = localMcpUrl(opts.port, opts.bind);
  return {
    status: 'plan',
    execute_required: true,
    execution_mode: opts.keepAlive ? 'keep-alive' : 'verify-and-stop',
    db_url_source: opts.dbUrlSource,
    has_db_url: opts.hasDbUrl,
    mcp_url: mcpUrl,
    serve_args: buildServeArgs({
      port: opts.port,
      bind: opts.bind,
      publicUrl: opts.publicUrl,
    }),
    readiness_gate: `bun scripts/rudy/remote-mcp-readiness.ts --url ${mcpUrl} --token-env GBRAIN_MCP_TOKEN --strict-full-surface`,
    ...(opts.dbUrlSource === 'config-file'
      ? { warning: 'Using database_url from ~/.gbrain/config.json. Prefer GBRAIN_DATABASE_URL for one-run activation so a bad saved password can be bypassed without rewriting config.' }
      : {}),
    ...(opts.dbUrlSource === 'missing'
      ? { warning: 'No database URL found. Set GBRAIN_DATABASE_URL to a valid Supabase Postgres URL before --execute.' }
      : {}),
  };
}

async function waitForHealth(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
  stderrTail: () => string = () => '',
): Promise<void> {
  const healthUrl = url.replace(/\/mcp$/, '/health');
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const tail = stderrTail().trim();
      throw new Error(`gbrain serve exited early with code ${child.exitCode}${tail ? `\n--- stderr tail ---\n${tail}` : ''}`);
    }
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise(resolveTimer => setTimeout(resolveTimer, 500));
  }
  throw new Error(`Timed out waiting for ${healthUrl}: ${lastError || 'no response'}`);
}

function parseCli(argv: string[]): {
  execute: boolean;
  port: number;
  bind: string;
  publicUrl?: string;
  claudeJson: string;
  server: string;
  timeoutMs: number;
  keepAlive: boolean;
} {
  let execute = false;
  let port = 3131;
  let bind = '127.0.0.1';
  let publicUrl: string | undefined;
  let claudeJson = '/Users/rudlord/.claude.json';
  let server = 'gbrain';
  let timeoutMs = 30_000;
  let keepAlive = false;

  const readValue = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') execute = true;
    else if (arg === '--keep-alive') keepAlive = true;
    else if (arg === '--port') port = Number(readValue(arg, i++));
    else if (arg === '--bind') bind = readValue(arg, i++);
    else if (arg === '--public-url') publicUrl = readValue(arg, i++);
    else if (arg === '--from-claude-json') claudeJson = readValue(arg, i++);
    else if (arg === '--server') server = readValue(arg, i++);
    else if (arg === '--timeout-ms') timeoutMs = Number(readValue(arg, i++));
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun scripts/rudy/local-http-activation.ts [--execute]

Plans or runs the fast local v0.42 activation path:
  1. start this checkout with gbrain serve --http
  2. reuse an existing bearer token from Claude JSON
  3. run the strict full-surface readiness gate

Options:
  --execute                Actually start the local HTTP server and probe it
  --keep-alive             After a successful full-surface probe, keep serving until interrupted
  --port N                 Local HTTP port (default: 3131)
  --bind HOST              Bind host (default: 127.0.0.1)
  --public-url URL         Optional public issuer URL for tunneled clients
  --from-claude-json PATH  Read existing bearer token from Claude JSON
  --server NAME            MCP server key in Claude JSON (default: gbrain)
  --timeout-ms N           Startup/probe timeout (default: 30000)

Set GBRAIN_DATABASE_URL to a valid Supabase Postgres URL before --execute.
The script redacts secrets and does not write ~/.gbrain/config.json.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(port) || port <= 0) throw new Error('--port must be a positive number');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
  return { execute, port, bind, publicUrl, claudeJson, server, timeoutMs, keepAlive };
}

async function configFileDbUrl(): Promise<string | undefined> {
  const mod = await import('../../src/core/config.ts');
  return mod.loadConfigFileOnly()?.database_url;
}

function makeLocalConfig(base: RemoteMcpConfig, url: string): RemoteMcpConfig {
  return { url, token: base.token, source: `${base.source} -> local-http` };
}

export function buildServeEnv(
  baseEnv: NodeJS.ProcessEnv,
  generatedBootstrapToken = randomBytes(36).toString('base64url'),
): { env: NodeJS.ProcessEnv; bootstrapToken: string } {
  const bootstrapToken = baseEnv.GBRAIN_ADMIN_BOOTSTRAP_TOKEN || generatedBootstrapToken;
  return {
    env: {
      ...baseEnv,
      GBRAIN_ADMIN_BOOTSTRAP_TOKEN: bootstrapToken,
    },
    bootstrapToken,
  };
}

async function waitForChildExit(child: ChildProcess): Promise<number> {
  return await new Promise(resolve => {
    child.once('exit', (code, signal) => {
      resolve(childExitCode(code, signal));
    });
  });
}

export function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code;
  if (signal === 'SIGINT' || signal === 'SIGTERM') return 0;
  return 1;
}

function installSignalForwarding(child: ChildProcess): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map(signal => {
    const handler = () => {
      if (child.exitCode === null) child.kill(signal);
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  };
}

if (import.meta.main) {
  let child: ChildProcess | null = null;
  const redactionSecrets = [
    process.env.GBRAIN_DATABASE_URL || '',
    process.env.DATABASE_URL || '',
  ];
  try {
    const cli = parseCli(process.argv.slice(2));
    const fileDbUrl = await configFileDbUrl();
    if (fileDbUrl) redactionSecrets.push(fileDbUrl);
    const hasConfigUrl = Boolean(fileDbUrl);
    const source = dbUrlSource(process.env, hasConfigUrl);
    const plan = buildPlan({
      port: cli.port,
      bind: cli.bind,
      publicUrl: cli.publicUrl,
      dbUrlSource: source,
      hasDbUrl: source !== 'missing',
      keepAlive: cli.keepAlive,
    });

    if (!cli.execute) {
      console.log(JSON.stringify(plan, null, 2));
      process.exit(source === 'missing' ? 1 : 0);
    }

    if (source === 'missing') {
      throw new Error('No database URL found. Set GBRAIN_DATABASE_URL before --execute.');
    }

    const bearerConfig = readClaudeMcpConfig(resolve(cli.claudeJson), cli.server);
    const { env, bootstrapToken } = buildServeEnv(process.env);
    redactionSecrets.push(bootstrapToken);
    const args = buildServeArgs({
      port: cli.port,
      bind: cli.bind,
      publicUrl: cli.publicUrl,
    });
    child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });

    const url = localMcpUrl(cli.port, cli.bind);
    await waitForHealth(url, child, cli.timeoutMs, () => stderr);
    const report = await buildReadinessReport(makeLocalConfig(bearerConfig, url), {
      requiredTools: [...DEFAULT_REQUIRED_TOOLS],
      timeoutMs: cli.timeoutMs,
    });
    console.log(JSON.stringify({
      ...report,
      db_url_source: source,
      local_http: true,
      execution_mode: cli.keepAlive ? 'keep-alive' : 'verify-and-stop',
    }, null, 2));
    if (!report.full_surface_ready) process.exitCode = 2;
    if (cli.keepAlive && report.full_surface_ready) {
      console.error(`GBrain local HTTP MCP is ready at ${url}; press Ctrl-C to stop.`);
      const cleanup = installSignalForwarding(child);
      try {
        const code = await waitForChildExit(child);
        child = null;
        if (code !== 0) process.exitCode = code;
      } finally {
        cleanup();
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = redactionSecrets.reduce((acc, secret) => redactSecret(acc, secret), msg);
    console.error(redacted);
    process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
    }
  }
}
