# PocketBase Service

This directory holds the self-hosted PocketBase backend service. It wraps PocketBase in a small Go server so we can register migrations, hooks, and custom API routes from code.

- `cmd/server/` contains the service entrypoint.
- `internal/migrations/` contains Go-based PocketBase collection migrations.
- `.env.example` documents the local environment variables used by the service.
- `pb_data/` is runtime data created by PocketBase and is intentionally ignored by git.

Start it locally with:

```bash
pnpm dev:infra
```

PocketBase will be available at `http://127.0.0.1:8090`.
