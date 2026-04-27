# PocketBase Service

This directory holds the self-hosted PocketBase backend surface.

- `pb_hooks/` is for PocketBase JavaScript hooks.
- `pb_migrations/` is for PocketBase collection migrations.
- `pb_data/` is runtime data and is intentionally ignored by git.

Start it locally with:

```bash
pnpm dev:infra
```

PocketBase will be available at `http://127.0.0.1:8090`.
