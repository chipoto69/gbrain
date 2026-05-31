#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RemoteMcpConfig {
  url: string;
  token: string;
  source: string;
}

export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[REDACTED]');
}

export function readClaudeMcpConfig(path: string, serverName = 'gbrain'): RemoteMcpConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const server = raw?.mcpServers?.[serverName];
  const url = server?.url;
  const auth = server?.headers?.Authorization ?? '';
  const token = String(auth).replace(/^Bearer\s+/i, '');
  if (!url || !token || token === auth && !/^Bearer\s+/i.test(auth)) {
    throw new Error(`No bearer-auth MCP server "${serverName}" found in ${path}`);
  }
  return { url, token, source: `${path}#mcpServers.${serverName}` };
}

function tokenFromEnv(envName: string, url: string): RemoteMcpConfig {
  const token = process.env[envName];
  if (!token) throw new Error(`Missing ${envName}; pass --from-claude-json or set ${envName}`);
  return { url, token, source: `env:${envName}` };
}

export function runAuthTest(config: RemoteMcpConfig, repoRoot: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [
    'run',
    'src/cli.ts',
    'auth',
    'test',
    config.url,
    '--token',
    config.token,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    url: config.url,
    source: config.source,
    stdout: redactSecret(result.stdout ?? '', config.token),
    stderr: redactSecret(result.stderr ?? '', config.token),
  };
}

function parseCli(argv: string[]): { config: RemoteMcpConfig; repoRoot: string } {
  let url = '';
  let tokenEnv = 'GBRAIN_MCP_TOKEN';
  let claudeJson = '';
  let server = 'gbrain';
  let repoRoot = process.cwd();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') url = argv[++i];
    else if (arg === '--token-env') tokenEnv = argv[++i];
    else if (arg === '--from-claude-json') claudeJson = argv[++i];
    else if (arg === '--server') server = argv[++i];
    else if (arg === '--repo-root') repoRoot = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun scripts/rudy/remote-mcp-canary.ts [--from-claude-json PATH] [--server gbrain]

Verifies an existing remote GBrain MCP bearer-token entry without printing the
token and without touching the live database directly.

Options:
  --from-claude-json PATH  Read mcpServers.<server>.url and Authorization
  --server NAME            MCP server key in Claude JSON (default: gbrain)
  --url URL                MCP URL when using an env token
  --token-env NAME         Env var containing bearer token (default: GBRAIN_MCP_TOKEN)
  --repo-root PATH         GBrain repo root for bun run src/cli.ts (default: cwd)`);
      process.exit(0);
    }
  }

  if (claudeJson) {
    return { config: readClaudeMcpConfig(resolve(claudeJson), server), repoRoot: resolve(repoRoot) };
  }
  if (!url) throw new Error('--url is required unless --from-claude-json is used');
  return { config: tokenFromEnv(tokenEnv, url), repoRoot: resolve(repoRoot) };
}

if (import.meta.main) {
  try {
    const { config, repoRoot } = parseCli(process.argv.slice(2));
    console.log(JSON.stringify(runAuthTest(config, repoRoot), null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
