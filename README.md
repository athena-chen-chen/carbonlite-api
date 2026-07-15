# CarbonLite AI API

NestJS backend for CarbonLite AI.

This service handles:

- document upload
- AI extraction
- activity data import
- metrics summary
- database access via Prisma

---

## Tech Stack

- NestJS
- Prisma
- PostgreSQL
- OpenAI API

---

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Choose a database

CarbonLite uses Prisma with `DATABASE_URL` from the root `.env` file.

Use Neon for shared/staging/production environments. Keep the Neon URL in `.env`
when the network can reach Neon:

```bash
DATABASE_URL="postgresql://USER:PASSWORD@YOUR-NEON-POOLER-HOST/neondb?sslmode=require"
```

Use local Postgres when Neon is unreachable or when you want an isolated dev
database. Copy the local example over `.env`:

```bash
cp .env.local.example .env
```

The local development URL is:

```bash
DATABASE_URL="postgresql://carbonlite:carbonlite@localhost:5432/carbonlite_dev?schema=public"
```

Do not commit `.env`. It is intentionally ignored by git.

### 3. Start local Postgres

With Docker Compose:

```bash
docker compose up -d postgres
```

Equivalent one-off Docker command:

```bash
docker run --name carbonlite-postgres \
  -e POSTGRES_USER=carbonlite \
  -e POSTGRES_PASSWORD=carbonlite \
  -e POSTGRES_DB=carbonlite_dev \
  -p 5432:5432 \
  -v carbonlite_postgres_data:/var/lib/postgresql/data \
  -d postgres:16
```

Check that local Postgres is reachable:

```bash
nc -vz localhost 5432
```

### 4. Prepare Prisma

Run migrations against whichever database your `.env` points to:

```bash
pnpm exec prisma migrate dev
pnpm exec prisma generate
```

Optional seed:

```bash
pnpm run seed
```

### 5. Start the API

```bash
pnpm dev
```

The API listens on `http://localhost:3333` by default.

---

## Backend Performance Logs

The API logs lightweight timing information in local development. Request logs
include method, URL, status code, and total duration, for example:

```text
GET /api/metrics/summary 200 143ms
SLOW POST /api/activity-data/bulk-import 201 1284ms
```

Requests over `1000ms` are marked with `SLOW`. The logs do not include request
bodies or uploaded file contents.

Metrics summary logs break the endpoint into:

- `total`: full summary endpoint duration
- `activityRecordQuery`: activity record database query duration
- `factorMatchingCalculation`: factor matching and emissions calculation duration
- `responseMapping`: response shaping duration

Import logs for JSON preview, bulk import, and confirmed document imports include
`parse`, `validation`, `databaseInsertUpdate`, and `total` durations. JSON
preview may also include `databaseRead` because it checks available factors but
does not write activity records.

If `/api/metrics/summary` is slow, first compare `activityRecordQuery` with
`factorMatchingCalculation`. A slow query points to database size, filters, or
indexes. Slow factor matching usually means the calculation is processing many
records or factor candidates and should be narrowed by date/report scope before
deeper optimization.

### Switching Between Neon And Local

To use local Postgres:

```bash
cp .env.local.example .env
docker compose up -d postgres
pnpm exec prisma migrate dev
pnpm dev
```

To switch back to Neon, replace `DATABASE_URL` in `.env` with the Neon pooled
connection string, including `sslmode=require`, then restart the API.

If migrations need a non-pooled Neon URL later, add `DIRECT_URL` locally and
update the Prisma datasource for migration workflows only. Runtime should keep
using `DATABASE_URL`.
