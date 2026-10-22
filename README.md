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
`JWT_SECRET` must be nonblank in every environment, including development and
test. There is no built-in fallback; startup fails before serving requests if
it is missing or blank. Supply a private environment-specific secret; never
use example placeholders in a deployed environment.
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

## Backend database test safety (F20)

Backend database E2E tests require a disposable PostgreSQL database on
`localhost`, `127.0.0.1`, or `::1`, named exactly `carbonlite_e2e`,
`carbonlite_test`, or `carbonlite_ci_test`. `carbonlite_e2e` matches the frontend
CI PostgreSQL service convention; this backend has no separate CI workflow.
The persistent Docker database `carbonlite_dev` is refused. Hosted databases,
including Neon, are refused; no hosted test branch has been verified.
Connection query options and fragments are refused to prevent destination or
schema overrides. `NODE_ENV`, `APP_ENV`, and reset/override flags cannot authorize
an unsafe database. Safety errors never include the supplied URL or credentials.

Create a separate empty database with one of these names, set `DATABASE_URL`
explicitly in your shell, and apply the existing migrations to that disposable
database before running `npm run test:e2e -- --runTestsByPath test/auth.e2e-spec.ts`.
Factor-dependent integration suites also need the existing baseline seed in that
disposable database. Validate the target before manually running migrations or
seeds; the general-purpose Prisma CLI and seed commands are not E2E wrappers.
Do not use the development environment file as your test target. The harness
neither migrates nor resets databases automatically. The guard runs before Nest
compiles the application, including when a single E2E file is run. Any new test
that compiles the database application directly must call
`assertSafeTestDatabaseTarget()` before compilation or destructive setup.

Run the guard and bootstrap regression tests without any database:
`node_modules/.bin/jest --config test/jest-safety.json --runInBand`.
Pure unit tests and the database-free logging E2E remain independent of this guard.
The sibling frontend helper retains its frontend fixture/reset flags; the backend
uses the same test database naming convention with stricter target validation.
