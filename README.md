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

### 2. Choose a development database

The backend runs locally on Mac, on port 3333. Its existing `dotenv/config`
imports load `.env` for plain `npm run dev` or `npm start`.
Use the explicit commands below to select a database without editing `.env`:

| Mode | Command | Ignored environment file |
| --- | --- | --- |
| Daily development | `npm run dev:neon` | `.env.neon.local` |
| Local fixtures / E2E | `npm run dev:localdb` | `.env.docker.local` |

Each file must contain its complete backend configuration, including
`DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=development`, and `APP_ENV=local`.
The selected file overrides inherited variables, and dotenv is pointed at that
same file so `.env` cannot supply a different database later.

Neon mode requires `sslmode=require` and `NEON_DEVELOPMENT_HOST` matching the
hostname of the development branch confirmed in the Neon console. Never use
Neon main, production, or staging. Hostname validation cannot determine a Neon
branch name; the console confirmation is required when configuring the file.

Local mode requires `localhost:5432/carbonlite_dev`. Keep the existing Docker
PostgreSQL container and volume. Start it if needed:

```bash
docker compose up -d postgres
```

Stop the backend with Ctrl+C before switching modes. Then run the other command.
The launcher refuses to start if port 3333 is occupied and prints only a safe
database label. Both modes use the existing Nest watch command; neither starts
the backend in Docker, migrates, resets, or seeds a database.

Demo authentication is disabled in both modes. Task 7 fixture opt-in is disabled
in Neon mode. Its existing local-only seed guard remains required and unchanged.
Keep all secrets in the ignored environment files; never commit them.

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

Stop the running backend with Ctrl+C, then run `npm run dev:neon` for daily
work or `npm run dev:localdb` for isolated Docker database testing. A running
Node process does not reload environment files; a full restart is required.
