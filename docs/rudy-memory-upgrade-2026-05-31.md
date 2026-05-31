# Rudy GBrain Memory Upgrade Notes 2026-05-31

## Canonical repositories

- `garrytan/gbrain` is the canonical code upstream.
- `chipoto69/gbrain` is Rudy's fork/integration remote and is behind upstream.
- `chipoto69/brain` is the private markdown canon repo. It is not a fork of
  `gbrain` and does not share Git history with it.

Post-fetch counts on 2026-05-31:

- Local `/Users/rudlord/gbrain` `master` is `0` ahead and `213` commits behind
  `garrytan/gbrain` `origin/master`.
- Preservation branch `preserve/local-384-embedding-20260531` is `1` ahead and
  `213` commits behind `garrytan/gbrain` `origin/master`.
- `chipoto69/gbrain` `fork/master` is `0` ahead and `144` commits behind
  `garrytan/gbrain` `origin/master`.

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
