# Foreman

A Node.js monorepo for project management infrastructure.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## Services

Start Postgres and Redis:

```bash
pnpm db:up
```

Stop services:

```bash
pnpm db:down
```

Services:
- PostgreSQL 16 on port 5433
- Redis 7 on port 6380
