# GBrain Memory Upgrade Notes 2026-05-31

## Canonical repositories

- `garrytan/gbrain` is the canonical code upstream.
- `chipoto69/gbrain` is the integration fork remote and is behind upstream.
- `chipoto69/brain` is the separate markdown canon repo. It is not a fork of
  `gbrain` and does not share Git history with it.

Post-upgrade counts on 2026-05-31:

- Local `~/gbrain` `master` tracks `fork/master` and is upgraded
  to the merged integration-fork tip `3f242da2`.
- Local `~/gbrain` `master` is `3` commits ahead and `0` commits
  behind `garrytan/gbrain` `origin/master`.
- Preservation branch `preserve/local-384-embedding-20260531` is `1` ahead and
  `213` commits behind `garrytan/gbrain` `origin/master`.
- `chipoto69/gbrain` `fork/master` is `3` commits ahead and `0` commits
  behind `garrytan/gbrain` `origin/master`.
- `chipoto69/gbrain` PR #1 was merged into `master` with commit `3f242da2`.

The three integration-fork commits preserve the 384-dimensional embedding contract,
add the local markdown canary, and add the remote MCP canary.

## Current local preservation

Before upgrading the live memory runtime, preserve:

- `~/gbrain` dirty patch: local 384-dimensional MiniLM embedding
  route and executable CLI bit.
- `~/gbrain/.worktrees/t_4573b52e`: nested clean worktree for
  older multi-agent hardening work.
- `~/brain`: markdown canon, currently ahead of its remote branch.

The local 384-dimensional patch is represented by branch:

```bash
preserve/local-384-embedding-20260531
```

The pre-upgrade local filesystem backup is:

```bash
~/Desktop/gbrain-preupgrade-20260531-231348
```

It includes the dirty working-tree patch, an all-refs bundle for
`~/gbrain`, the nested `.worktrees/t_4573b52e` worktree archive,
and a `~/brain` working-copy backup.

## Non-negotiable live-memory invariant

The existing Supabase-backed memory has 384-dimensional embeddings. Upstream
v0.42 has a provider gateway and dimension checks; keep the live contract
explicit before any migration:

```json
{
  "embedding_model": "openai:all-MiniLM-L6-v2",
  "embedding_dimensions": 384
}
```

If the model is served by an OpenAI-compatible local/proxy endpoint, keep the
matching `provider_base_urls.openai` entry. Do not let v0.42 fall back to its
default embedding dimensions.

## Blocker before live mutation

The local CLI config currently cannot authenticate to Postgres. Do not run
`gbrain apply-migrations`, `gbrain init`, `gbrain sync --all`, or normal
`bun install` without a verified database URL and a fresh `pg_dump`.

Safe install/build inspection command:

```bash
bun install --ignore-scripts
```

Direct local DB auth still fails with the existing `~/.gbrain/config.json`
password. The config is pinned to:

```json
{
  "embedding_model": "openai:all-MiniLM-L6-v2",
  "embedding_dimensions": 384
}
```

Keep that pin. Fix the database URL or password before any host-side migration,
bulk sync, or import run.

## Live Supabase backup and readiness

The configured Supabase project is the live GBrain data substrate. An
in-database backup schema was created and verified before any live migration
attempt:

```bash
gbrain_backup_20260531_214413
```

Critical backup row counts matched public row counts at creation time:

| table | rows |
| --- | ---: |
| access_tokens | 1 |
| content_chunks | 4534 |
| ingest_log | 70 |
| links | 535 |
| mcp_request_log | 78856 |
| oauth_clients | 0 |
| page_versions | 152 |
| pages | 883 |
| raw_data | 2 |
| tags | 968 |
| timeline_entries | 18 |

This is useful rollback evidence, but it is not a replacement for an external
`pg_dump`. Take a real dump before destructive schema changes, broad import, or
embedding rewrites.

Reusable SQL probes live in:

```bash
scripts/rudy/supabase-preupgrade-backup.sql
scripts/rudy/supabase-readiness.sql
```

Use them to create a fresh timestamped backup schema and compare live public
counts against that backup.

The guarded one-shot activation wrapper sequences the safe path after a valid
Supabase Postgres URL exists:

```bash
bun scripts/rudy/live-v042-activation.ts
```

The plan intentionally ignores `DATABASE_URL` and `~/.gbrain/config.json`.
Execution requires `GBRAIN_DATABASE_URL` and then runs:

1. read-only database credential and 384-dimensional invariant preflight
2. external `pg_dump` to a timestamped local file
3. timestamped in-database backup SQL
4. readiness SQL plus hard assertions for `embedding_dimensions=384`,
   `embedding_model=openai:all-MiniLM-L6-v2`, `vector(384)`, nonempty critical
   memory tables, and stable public-vs-backup row-count parity. Volatile
   request telemetry such as `mcp_request_log` is reported but not exact-parity
   gated because MCP probes can append rows while the backup is running.
5. local v0.42 HTTP MCP activation with `--keep-alive`

```bash
GBRAIN_DATABASE_URL='postgresql://...' \
  bun scripts/rudy/live-v042-activation.ts --execute
```

To prove a candidate database URL before creating a dump, writing rendered SQL,
creating a backup schema, or starting a server:

```bash
GBRAIN_DATABASE_URL='postgresql://...' \
  bun scripts/rudy/live-v042-activation.ts --execute --preflight-only
```

This runs only `scripts/rudy/supabase-db-preflight.sql`: it authenticates with
the supplied URL, checks the `384` embedding contract and nonempty critical
memory tables, then exits.

This wrapper writes rendered SQL files and a custom-format dump under
`~/Desktop/gbrain-live-v042-activation/` by default. It does not
put the database URL on `pg_dump` or `psql` argv; it derives `PGHOST`,
`PGDATABASE`, `PGUSER`, `PGPASSWORD`, and `PGSSLMODE` in the child environment
instead.

Current live readiness markers:

- `public.config.version` is still `1`.
- `public.config.embedding_dimensions` is `384`.
- `public.config.embedding_model` is `openai:all-MiniLM-L6-v2`.
- `public.content_chunks.embedding` is `vector(384)`.
- The database has a mixed upgraded shape, including newer MCP/OAuth/logging
  tables, so do not blindly replay all upstream migrations against it.

## Deployed Edge MCP state

The deployed Supabase Edge function `gbrain-mcp` is active and works for MCP
operations through the existing bearer-token config, but its bundled
`gbrain-core.js` reports package version `0.7.0`. That is older than the local
v0.42.1.0 code now present in `~/gbrain`.

The remote MCP canary currently verifies:

- initialize handshake
- `tools/list`
- `get_stats`

Treat the Edge function as the immediate integration path for agents, not as a
proof that the deployed service has all v0.42 features. Upgrading the Edge
function needs its own deploy plan after DB credentials and migration readiness
are settled.

Live probe result on 2026-05-31:

- status: `not_ready` for full memory-module activation
- deployed version: `0.7.0`
- remote tools: `25`
- local v0.42 remote-callable HTTP tools: `81`
- local v0.42 host-only tools intentionally excluded from HTTP MCP: `7`
- missing required write tool: `put_page`

The deployed Edge MCP is still useful for read/search and limited write
surfaces such as tags, links, timeline entries, and raw data. It is not safe to
advertise it as the full page-write memory module until `put_page` is available
or a v0.42 `gbrain serve --http` deployment is reachable.

For architecture integration, use the richer readiness probe:

```bash
bun scripts/rudy/remote-mcp-readiness.ts \
  --from-claude-json ~/.claude.json \
  --server gbrain
```

This reports whether the remote is `full`, `limited`, or `not_ready`.
`limited` means the core memory operations are usable, but the deployed remote
does not expose the full local v0.42 remote-callable HTTP tool surface. To make
that gap fail hard:

```bash
bun scripts/rudy/remote-mcp-readiness.ts \
  --from-claude-json ~/.claude.json \
  --server gbrain \
  --strict-full-surface
```

## Fast local v0.42 activation path

The fastest full-surface path is to run this checkout as the HTTP MCP server
against the live Supabase database, then point architecture clients at that
local/tunneled endpoint. This avoids deploying a risky new Supabase Edge bundle
while still exposing the local v0.42 remote-callable HTTP tool registry.

Plan the activation without starting anything:

```bash
bun scripts/rudy/local-http-activation.ts
```

Run it after supplying a valid Supabase Postgres URL as an env override:

```bash
GBRAIN_DATABASE_URL='postgresql://...' \
  bun scripts/rudy/local-http-activation.ts --execute
```

Keep the verified v0.42 HTTP MCP process running for local architecture
clients after the strict readiness gate passes:

```bash
GBRAIN_DATABASE_URL='postgresql://...' \
  bun scripts/rudy/local-http-activation.ts --execute --keep-alive
```

The script starts:

```bash
bun run src/cli.ts serve --http --port 3131 --bind 127.0.0.1 --suppress-bootstrap-token
```

Then it reuses the existing bearer token from `~/.claude.json`
and runs the strict full-surface readiness gate against
`http://127.0.0.1:3131/mcp`.

Without `--keep-alive`, the script is a proof gate and stops the child server
after reporting readiness. With `--keep-alive`, it forwards SIGINT/SIGTERM to
the child server and keeps serving until interrupted.

Current execute result on 2026-06-01: the harness starts the right v0.42 path
but `gbrain serve` exits before `/health` because the saved
`~/.gbrain/config.json` database URL cannot authenticate:

```text
password authentication failed for user "postgres"
```

Do not rewrite `~/.gbrain/config.json` unless the operator wants the new URL
persisted. Prefer `GBRAIN_DATABASE_URL=...` for one-run activation and proof.

## One-file canary

Use the canary before any broad import:

```bash
bun scripts/rudy/brain-md-canary.ts \
  --file ~/brain/example/canary-note.md
```

After DB auth is fixed and a backup exists:

```bash
bun scripts/rudy/brain-md-canary.ts \
  --file ~/brain/example/canary-note.md \
  --execute
```

The canary derives a `brain/...` slug, injects source provenance, writes through
`gbrain capture`, then verifies the page through `get`, chunks, and search.

Do not treat `ingest_log` as proof of memory. A write is successful only when
the page, chunks or explicit skip reason, and retrieval proof exist.

## Immediate remote MCP plug-in path

The existing Claude/Codex MCP entry can be used as the fast read/write surface
for agents while direct local DB auth is repaired. Verify it without printing
the bearer token:

```bash
bun scripts/rudy/remote-mcp-canary.ts \
  --from-claude-json ~/.claude.json \
  --server gbrain
```

Expected successful checks:

- initialize handshake
- `tools/list`
- `get_stats`

For an integration-ready status report that compares the deployed remote MCP
against the local v0.42 remote-callable HTTP tool registry:

```bash
bun scripts/rudy/remote-mcp-readiness.ts \
  --from-claude-json ~/.claude.json \
  --server gbrain
```

This route talks to the deployed Supabase Edge MCP endpoint and does not require
the broken local `database_url`. It is suitable for MCP-equivalent read/search
operations and limited writes such as tags, links, timeline entries, and raw
data. It is not a replacement for page writes, host-side DB access, migrations,
backups, sync/import, or re-embedding.
