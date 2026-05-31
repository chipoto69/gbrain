# Rudy GBrain Memory Upgrade Notes 2026-05-31

## Canonical repositories

- `garrytan/gbrain` is the canonical code upstream.
- `chipoto69/gbrain` is Rudy's fork/integration remote and is behind upstream.
- `chipoto69/brain` is the private markdown canon repo. It is not a fork of
  `gbrain` and does not share Git history with it.

Post-upgrade counts on 2026-05-31:

- Local `/Users/rudlord/gbrain` `master` tracks `fork/master` and is upgraded
  to the merged Rudy fork tip `3f242da2`.
- Local `/Users/rudlord/gbrain` `master` is `3` commits ahead and `0` commits
  behind `garrytan/gbrain` `origin/master`.
- Preservation branch `preserve/local-384-embedding-20260531` is `1` ahead and
  `213` commits behind `garrytan/gbrain` `origin/master`.
- `chipoto69/gbrain` `fork/master` is `3` commits ahead and `0` commits
  behind `garrytan/gbrain` `origin/master`.
- `chipoto69/gbrain` PR #1 was merged into `master` with commit `3f242da2`.

The three Rudy fork commits preserve the 384-dimensional embedding contract,
add the local markdown canary, and add the remote MCP canary.

## Current local preservation

Before upgrading the live memory runtime, preserve:

- `/Users/rudlord/gbrain` dirty patch: local 384-dimensional MiniLM embedding
  route and executable CLI bit.
- `/Users/rudlord/gbrain/.worktrees/t_4573b52e`: nested clean worktree for
  older multi-agent hardening work.
- `/Users/rudlord/brain`: markdown canon, currently ahead of its remote branch.

The local 384-dimensional patch is represented by branch:

```bash
preserve/local-384-embedding-20260531
```

The pre-upgrade local filesystem backup is:

```bash
/Users/rudlord/Desktop/gbrain-preupgrade-20260531-231348
```

It includes the dirty working-tree patch, an all-refs bundle for
`/Users/rudlord/gbrain`, the nested `.worktrees/t_4573b52e` worktree archive,
and a `/Users/rudlord/brain` working-copy backup.

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

Supabase project `dpithlomjfosidmgdopm` is the live GBrain data substrate. An
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

Current live readiness markers:

- `public.config.schema_version` is still `1`.
- `public.config.embedding_dimensions` is `384`.
- `public.config.embedding_model` is `openai:all-MiniLM-L6-v2`.
- `public.content_chunks.embedding` is `vector(384)`.
- The database has a mixed upgraded shape, including newer MCP/OAuth/logging
  tables, so do not blindly replay all upstream migrations against it.

## Deployed Edge MCP state

The deployed Supabase Edge function `gbrain-mcp` is active and works for MCP
operations through the existing bearer-token config, but its bundled
`gbrain-core.js` reports package version `0.7.0`. That is older than the local
v0.42.1.0 code now present in `/Users/rudlord/gbrain`.

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
- local v0.42 tools: `88`
- missing required write tool: `put_page`

The deployed Edge MCP is still useful for read/search and limited write
surfaces such as tags, links, timeline entries, and raw data. It is not safe to
advertise it as the full page-write memory module until `put_page` is available
or a v0.42 `gbrain serve --http` deployment is reachable.

For architecture integration, use the richer readiness probe:

```bash
bun scripts/rudy/remote-mcp-readiness.ts \
  --from-claude-json /Users/rudlord/.claude.json \
  --server gbrain
```

This reports whether the remote is `full`, `limited`, or `not_ready`.
`limited` means the core memory operations are usable, but the deployed remote
does not expose the full local v0.42 tool surface. To make that gap fail hard:

```bash
bun scripts/rudy/remote-mcp-readiness.ts \
  --from-claude-json /Users/rudlord/.claude.json \
  --server gbrain \
  --strict-full-surface
```

## One-file canary

Use the canary before any broad import:

```bash
bun scripts/rudy/brain-md-canary.ts \
  --file /Users/rudlord/brain/personal/agent2human-advice.md
```

After DB auth is fixed and a backup exists:

```bash
bun scripts/rudy/brain-md-canary.ts \
  --file /Users/rudlord/brain/personal/agent2human-advice.md \
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
  --from-claude-json /Users/rudlord/.claude.json \
  --server gbrain
```

Expected successful checks:

- initialize handshake
- `tools/list`
- `get_stats`

For an integration-ready status report that compares the deployed remote MCP
against the local v0.42 tool registry:

```bash
bun scripts/rudy/remote-mcp-readiness.ts \
  --from-claude-json /Users/rudlord/.claude.json \
  --server gbrain
```

This route talks to the deployed Supabase Edge MCP endpoint and does not require
the broken local `database_url`. It is suitable for MCP-equivalent read/search
operations and limited writes such as tags, links, timeline entries, and raw
data. It is not a replacement for page writes, host-side DB access, migrations,
backups, sync/import, or re-embedding.
