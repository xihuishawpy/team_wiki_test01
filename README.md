# Team Wiki application

This repository is the modular-monolith application scaffold for the internal Team Wiki. It
contains the browser shell, NestJS/Fastify API, PostgreSQL migrations and three background-worker
roles. Published content is intentionally stored in a separate private content repository; this
application repository never writes content during local startup.

The current milestone is infrastructure only. Authentication, drafts, publication and
classification arrive in later issues.

## Prerequisites

- Node.js `24.18.0` (the supported `24.x` LTS line)
- pnpm `10.32.1`
- Docker with Compose v2 for the repeatable full stack

Runtime and database images are pinned to `node:24.18.0-alpine3.23` and
`postgres:18.4-alpine3.23`. Dependency versions and the pnpm lockfile are committed.
PostgreSQL 18 stores its versioned data directory under `/var/lib/postgresql`; the Compose volume
uses that new parent mount rather than the pre-18 `/var/lib/postgresql/data` path.

## Start a clean local stack

```bash
cp .env.example .env
docker compose up --build
```

Compose waits for PostgreSQL, runs all pending migrations once, applies runtime grants, then starts
the API, local fake external services and the publish/classify/reconcile workers. Each runtime uses
a separate non-owner database login; only the one-shot migrator owns schema objects. Open
`http://localhost:3000`.

Health endpoints:

- `GET /health/live` only proves that the process can answer.
- `GET /health/ready` returns `503` when PostgreSQL or migrations are unavailable. Disabled
  GitHub/model integrations produce a non-secret `degraded` response while core reading remains
  available.

Reset the local database only when local data is disposable:

```bash
docker compose down --volumes
```

## Native development

Install dependencies and point `DATABASE_URL` at PostgreSQL 18. Never put a real password in a
tracked file.

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm start:api
```

Run a worker in another terminal:

```bash
pnpm start:worker:publish
pnpm start:worker:classify
pnpm start:worker:reconcile
```

The local GitHub/model fake is opt-in and refuses to run in production:

```bash
ALLOW_FAKE_EXTERNAL=true pnpm start:fake-external
```

## Migrations

Each migration has matching `*.up.sql` and `*.down.sql` files. The runner holds a PostgreSQL
advisory lock, verifies the SHA-256 checksum of every applied migration and executes the selected
direction in a transaction.

```bash
pnpm db:status
pnpm db:migrate
pnpm db:rollback
```

Do not edit an applied migration. Add a new forward migration and a tested rollback. In production,
back up first and prefer a forward repair when a rollback would discard user data.

## Verification

```bash
pnpm verify
```

`pnpm test:integration` uses `TEST_DATABASE_URL`; without it, PostgreSQL-only suites are reported as
skipped. The unified command also checks formatting, lint and private-import boundaries, OpenAPI
lint/drift, types, unit/E2E/browser smoke, the production dependency audit and the build. CI
supplies a real PostgreSQL 18 service, runs a dedicated secret scanner and verifies migrate →
rollback → migrate.

The committed OpenAPI 3.1 contract lives at `contracts/openapi.yaml`; generated TypeScript types
live at `contracts/generated/openapi.ts`. `pnpm contracts:check` fails when generated types drift.

## Runtime and secret boundaries

The same image starts one of these commands:

| Role       | Command                                   | Secret scope                                      |
| ---------- | ----------------------------------------- | ------------------------------------------------- |
| API        | `node apps/api/dist/main.js`              | No GitHub App private key or model key            |
| Publisher  | `node apps/worker/dist/main.js publish`   | Publisher App key only when enabled               |
| Classifier | `node apps/worker/dist/main.js classify`  | Read-only App key and model key only when enabled |
| Reconciler | `node apps/worker/dist/main.js reconcile` | Read-only App key only when enabled               |

Configuration is validated at startup. Missing required names fail closed; errors and health output
never echo values. `.env.example` contains disabled integrations and local-only placeholders. Real
credentials belong in the deployment secret manager and must be injected only into the consuming
role.

The Compose credentials are disposable development defaults. Production must create equivalent
separate roles with generated passwords and inject only the corresponding `DATABASE_URL`. After
changing local role passwords or grants, recreate the disposable database volume so the PostgreSQL
initialization scripts run again.

Workers claim jobs with `FOR UPDATE SKIP LOCKED`, a time-bounded lease and a `(kind, dedupe_key)`
unique constraint. Delivery is at-least-once, so every future business handler must enforce its own
domain idempotency key before changing state. PostgreSQL row-level policies restrict each worker to
its own job-kind prefix. Unknown payload versions enter a distinct dead-letter terminal state and
emit a structured error event suitable for alerting; payload bodies are never logged.

## Architecture

- `apps/api` — REST and health boundary; serves the built web shell.
- `apps/web` — React/Vite browser shell.
- `apps/worker` — publish, classify and reconcile worker entry points.
- `apps/fake-external` — deterministic local-only GitHub/model stub.
- `packages/platform` — configuration, PostgreSQL, migration, queue and observability primitives.
- `packages/modules` — public module ownership/dependency/adapter-port contracts.
- `migrations` — reversible explicit SQL migrations.
- `contracts` — approved OpenAPI contract and generated types.
- `docs/architecture` — accepted technical baseline and future full-schema reference.

The accepted architecture deliberately excludes Redis, a separate message broker and Elasticsearch
for the MVP. See `docs/architecture/technical-baseline.md` for ADRs and future module boundaries.
