# Phase D local Work/Control pool prototype

This is an opt-in local experiment, not an RC deployment configuration or capacity certification. No authorization, consent, factor-governance, schema or migration rules change.

## Follow-up implementation

The original local-only validation below is historical. The separate RC-safe activation, bounded admission, PgBouncer and process-crash hardening is documented in [Phase D release hardening](phase-d-release-hardening-v0.1.md). It does not activate RC or certify deployment capacity. Existing local restrictions remain.

## Activation and boundaries

`LOCAL_CONTROL_POOL_PROTOTYPE=true` requires APP_ENV local/development/test, NODE_ENV development/test, and a loopback PostgreSQL URL naming the disposable `carbonlite_ci_test` or `carbonlite_test` database. Non-local endpoints, RC database names, host overrides and unsupported modes fail startup. No second credential or connection URL is introduced. Do not enable this prototype in RC, Preview or Production.

Without the flag, existing single-pool behavior remains explicit; no Control client is constructed. Facilities now imports the shared PrismaModule instead of registering another PrismaService. The active AppModule graph therefore has one ordinary Work client. Dormant modules not imported by AppModule are outside this runtime graph.

With the flag, Work has connection_limit=4 and Control has connection_limit=2; both derive the same endpoint, database and role from the existing local test configuration. Pool/connect timeouts are one second. These are experimental limits, not deployment defaults.

## Control operations and authentication

Only POST real-data withdrawal, AI withdrawal and customer suspension are marked by server-owned route middleware. JWT signature verification remains normal Passport verification. The existing live user/organization/membership read uses the Control transaction for those routes; role, account expiry, tenant and suspension checks remain unchanged. Ordinary login and application authentication/queries stay on Work.

Real-data withdrawal, AI withdrawal and suspension each own a Control transaction. Suspension passes that exact transaction into real-data withdrawal; bound AI withdrawal, authorization evidence and required audits share it. There is no root Work acquisition inside these callbacks. Enabled-mode initialization/acquisition failures and missing wiring never fall back to Work. Nested Control transactions are rejected. Both clients disconnect through Nest lifecycle hooks; application shutdown hooks are enabled.

## Budgets and durable results

- Authorization/database lock wait: 250 ms, transaction-local lock_timeout.
- Control acquisition: 500 ms maxWait.
- Owning operation transaction: 5 seconds; authentication: 1 second.
- Request deadline: approximately 6 seconds starting before authentication.

Statement and interactive-transaction budgets bound database work. Callback deadline checks prevent delayed callbacks from later committing. PostgreSQL/Prisma rolls back expired transactions even when an application callback is blocked. Timers cannot guarantee a wall-clock SLA under event-loop stalls, network partitions, proxy delays or infrastructure outages.

Success is returned only after the owning transaction acknowledges commit. Fence contention/capacity/known rollback returns a bounded error without success. Lost commit acknowledgements or request-deadline races return `CONTROL_OUTCOME_UNCERTAIN`, require authoritative reconciliation, and prohibit automatic retries. A timeout does not imply rollback if commit acknowledgement was lost. After restoring connectivity/capacity, inspect authoritative authorization, evidence and audit state before considering a separate operator submission.

Storage and provider work remains outside database transactions. Existing durable operation identity and revision fencing prevent withdrawn/stale operations from committing. A final commit that already owns the authorization fence may win; withdrawal then reports bounded contention and does not claim success. No provider call is undone by withdrawal. No external work or authorization architecture was moved in this batch.

Control diagnostics contain fixed operation/outcome labels and numeric acquisition/duration values only. No connection URL, credential, actor, document or query payload is logged by this component.

## Local evidence and release gate

The disposable PostgreSQL suite uses barriers and database transaction state rather than sleeps for ordering. It covers 4+2 saturated connections, live authentication isolation, blocked storage/provider work, concurrent tenants, final-fence ordering, suspension, acquisition/transaction/request timeouts, required-audit rollback, lost acknowledgements, stale reapproval, ordinary Facilities access and disconnect lifecycle. Providers are mocked and all data is synthetic.

Peak application connection demand for the tested one-process prototype is six. Maintenance, migrations, operator sessions and monitoring are additional consumers, not included in that cap. The observed local backend count does not establish Neon capacity.

Before any deployment proposal, independently verify minimum-compute/autoscaling backend limits, PgBouncer per-role/database pool limits, application-to-pooler connection ceilings, timeout semantics, competing consumers, maintenance reserve, process/replica counts and restart overlap. Two Prisma pools using the same pooled endpoint do not by themselves reserve distinct upstream PostgreSQL capacity. Validate pressure and withdrawal latency through the actual pooler. Phase E operational/recovery review and an explicit deployment/capacity approval remain outstanding.


## Validation record (2026-11-18)

- Baseline: `5e138668fb39bcd70ea27c5ab87903cb2b59f6c2`, clean `fix/phase2-retained-document-security` worktree before implementation.
- New deterministic PostgreSQL prototype coverage: 18/18, no skips. Successful withdrawal requests with four Work connections held measured 19, 20 and 29 ms in the dedicated run. These are local observations, not SLAs.
- Existing authorization/extraction/quota/recovery regression suites with the prototype enabled: 162/162 across eight suites.
- Full PostgreSQL E2E: 378/378 across 49 suites, zero failures/skips. Existing suites use their default configuration; the dedicated prototype suite opts in explicitly.
- Full units: 849/849 across 74 suites, including all 22 new configuration/control-ownership tests.
- TypeScript, build, Prisma validation and lint: PASS. Lint retains 12 existing warnings; no new warnings.
- Disposable PostgreSQL migrations: 60 total/distinct/applied, zero unfinished. No schema/migration files changed.
- Expected acquisition, fence, transaction and request-deadline failures were asserted; no unexpected timeout or downstream failure remained.
- The first executable prototype run passed 11/13. Its two new fixture expectations were corrected to match existing contracts: suspended customer authentication returns 401, and withdrawal confirms exact organization IDs (slug equality is not checked by that existing service). No production confirmation or authorization rule was changed to satisfy the fixtures. Preliminary test typing errors were also corrected.
- No live environment, real provider, credential, deployment or Git remote was used or changed. Tests used only a disposable local PostgreSQL container and synthetic fixtures.

Exact changed files:

- `src/prisma/control-pool.configuration.ts`
- `src/prisma/control-pool.configuration.spec.ts`
- `src/prisma/control-database.service.ts`
- `src/prisma/control-database.service.spec.ts`
- `src/prisma/control-request.context.ts`
- `src/prisma/prisma.module.ts`
- `src/prisma/prisma.service.ts`
- `src/facilities/facilities.module.ts`
- `src/auth/auth.service.ts`
- `src/auth/jwt.strategy.ts`
- `src/real-data-authorization/real-data-authorization.service.ts`
- `src/ai-authorization/ai-authorization.service.ts`
- `src/customer-provisioning/customer-provisioning.service.ts`
- `src/main.ts`
- `test/control-pool-prototype.e2e-spec.ts`
- `docs/compliance/local-control-pool-prototype-v0.1.md`

Local prototype ready for further code/security review. Phase D is not release-ready until deployment capacity and upstream pooling assumptions are independently validated.
