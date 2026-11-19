# Phase D release hardening — local implementation

Status: local review candidate only. No Clean RC activation, remote push, merge, deployment, live database access, credential retrieval, HMAC/JWT change, schema change or migration is authorized by this record. Provider calls are mocked. Production, Preview and Niall remain out of scope.

## Activation contract

The existing `LOCAL_CONTROL_POOL_PROTOTYPE=true` mode remains restricted to disposable loopback databases and local/test environment classifications. It does not authorize RC access.

A separate `CONTROL_POOL_MODE=clean-rc-v1` requires APP_ENV=rc, NODE_ENV=production, the approved Render service ID and release branch, plus `CONTROL_POOL_RC_MANIFEST`. Conflicting local activation or a manifest without RC mode is rejected. No default or automatic RC activation exists.

The manifest is JSON with exactly these fields (no usable manifest or endpoint is supplied here):

| Field | Required value/source |
| --- | --- |
| version | 1 |
| renderServiceId | srv-dbtppde7bikc73fcg2j0 |
| neonProjectId | gentle-art-04408150 |
| neonBranchId | br-shiny-boat-bcll0hxz |
| database | carbonlite_rc |
| runtimeRole | carbonlite_rc_app |
| endpointHostname | Exact pooled hostname independently verified by the operator |
| releaseSha | Exact independently approved SHA, matching Render deployment metadata |
| approvalReference | Actual operator approval record reference; synthetic references rejected |
| workPoolLimit | 4 |
| controlPoolLimit | 2 |

Render service/branch/commit metadata must match. The existing runtime URL must match the manifest's endpoint, database and role, with required TLS and strict certificate acceptance. Redirecting query options, duplicate options and unsupported ports/options are refused. Connection options are constructed in memory; the existing credential is not rewritten, copied into documentation or logged.

The manifest is a trusted operator configuration assertion, not a cryptographically verified approval receipt. SQL cannot independently prove the Neon project/branch. Operators must verify the hostname-to-project/branch association outside the application before approving configuration. Pure parser-model tests are not deployment approvals and construct no client. Explicit synthetic manifests cannot activate RC; local SQL tests use only disposable identities.

## Awaited startup and identity

The Work provider factory connects and performs a read-only identity transaction before returning the client. The Control factory then connects/verifies its own client. Nest cannot complete initialization/listen or run application startup hooks until these async factories resolve. There is no third identity-verification pool.

Both clients verify actual current_database(), current_user and session_user. RC additionally rejects elevated role flags. This is an identity/obvious-elevation check, not a complete privilege or role-membership audit; the operator must separately confirm least privilege. Queries select no application/customer data. Wrong identities, missing approval, connection failure and malformed configuration fail closed. A failed Work instance disconnects itself; a failed Control activation closes Control and Work. Error messages do not include raw driver payloads, URLs or credentials. Successful initialization is cached, not repeated by lifecycle hooks.

The role remains carbonlite_rc_app for both clients. No new role, grants, password or direct endpoint is introduced. Facilities continues to share Work. Existing authorization guards and revision fences are unchanged.

## Admission, timeouts and recovery

- One Work client, limit 4; one Control client, limit 2, per enabled process.
- One control request in flight per process, covering live JWT database validation and the complete mutation. There is no application waiting queue. Excess requests fail before mutation with CONTROL_ADMISSION_BUSY; shutdown rejects admission.
- A permit is released only after the HTTP response ends AND every underlying database promise settles. A deadline response does not cancel Prisma. Pending work therefore cannot accumulate new requests/clients behind it. No automatic client replacement or resubmission occurs.
- Direct service calls use the same admission mechanism. Owning callbacks use the supplied Control transaction; nested Control transactions are rejected. Reviewed paths do not acquire Work within Control transactions.
- Expensive extraction admission is capped at two per process even for quota-enabled organizations. Stricter organization quota limits still apply, and quota accounting is unchanged. Multiple processes multiply this process-local ceiling; it is not cluster-wide reservation.
- Authorization/database lock_timeout is 250 ms and transaction-local. Control acquisition maxWait is 500 ms, the transaction budget is at most 5 seconds, authentication at most 1 second, and the request deadline approximately 6 seconds including authentication.

Successful withdrawal requires acknowledged commit. Required authorization/evidence/audit mutations remain atomic. Lost acknowledgement or request-deadline uncertainty returns CONTROL_OUTCOME_UNCERTAIN, outcome UNKNOWN, reconciliationRequired=true, automaticRetry=false. A known pre-commit rollback must not be represented as successful withdrawal. Control-capacity rejection of a second request is NOT_COMMITTED for that second request; it says nothing about the first uncertain request.

The disposable PgBouncer test observed a queued BEGIN surviving Prisma's application maxWait and reaching the request deadline. The expected outcome is UNKNOWN, not a claim that maxWait limits upstream waiting. SHOW POOLS confirms upstream cl_waiting with two occupied server slots. A second request is rejected without another transaction; after upstream release and underlying settlement, whenIdle() provides a deterministic drain barrier and a fresh query succeeds. No latency SLA follows from this test.

Shutdown waits for admitted requests and their database promises before disconnecting Control. A real SIGTERM test releases a prepared withdrawal during drain and verifies durable commit/audit before exit. Drain time is not guaranteed while upstream pressure or a network outage persists; the platform grace/forced-termination behavior remains a deployment verification item. A forced termination requires the same authoritative reconciliation as a crash. No retry is hidden in shutdown or recovery.

## Crashes, leases and provider uncertainty

Disposable subprocess tests replace the provider module before loading application code; no SDK request is sent. IPC barriers place process death before dispatch, after durable dispatch admission/provider-stub acceptance, before final commit and after final commit but before HTTP success. A TCP protocol fixture separately discards a real PostgreSQL COMMIT completion message after server commit.

Before final commit, protected result and success-audit writes roll back. After commit, complete result/audit/job state remains durable. Restart does not automatically dispatch, replay or publish old operations. Expired leases fence stale finalization and cleanup; a new explicit attempt preserves the previous operation history. A newer successful attempt cannot be overwritten by the old one.

DISPATCH_ADMITTED proves admission, not exactly-once provider delivery. A crash can leave external delivery unknown, even if the local lease later becomes FAILED. Retain decision/revision, phase, audit and lease history for reconciliation. Lease expiry alone is not permission for an automatic external-provider replay. The tests perform a separate explicit synthetic retry after inspecting state; production operators need an explicit decision after reconciliation. Never claim exactly-once external delivery.

Concurrent same-organization withdrawal and suspension are admission-controlled. The rejected request creates no suspension mutation/audit; a separate explicit action after reconciling the first operation completes suspension without duplicate withdrawal evidence. Two-process tests verify twelve distinct held application connections. Existing finalization/tenant guards reject stale operations across restart.

## Capacity and release prerequisites

For one Phase D process the application ceiling is six connections; for two Phase D processes, twelve. Readiness probes and ordinary authentication share Work. Standalone scripts, migrations, monitoring, maintenance, abandoned sessions and other roles are additional consumers. Two same-role/database clients share the upstream PgBouncer pool; application_name labels create no upstream reservation or priority.

Operator-supplied RC settings remain reference evidence only: max_connections=901, reserved slots=4+0, role/database limits=-1, one active Render process, pooled Neon endpoint. The actual pooler size/overrides, wait/cancellation semantics, minimum-compute throughput, occupancy and maintenance allowance require approved deployment-specific evidence. Six low-volume application connections do not imply six guaranteed usable backend slots.

First deployment or rollback overlap must include the older RC release's independent client demand, not assume twelve. Initial operation should use a controlled drain/stop/start window unless actual overlap is measured and approved. Application CPU/event-loop stalls, memory pressure and database locks can still delay withdrawal despite separate clients.

The existing pooled role is retained until evidence justifies another design. A separate role gets a separate per-role pool but not global reserved capacity. A direct Control endpoint bypasses PgBouncer waiting but still needs PostgreSQL headroom and separate credential/permission approval. Neither is an automatic fallback.

Required operator actions before RC:

1. Verify the exact service, Neon branch/project, pooled endpoint and runtime role through approved non-secret metadata access; do not retrieve credentials into a transcript.
2. Verify actual pooler capacity/occupancy, competing consumers, minimum-compute behavior, Render health/restart policy, old-release pool demand and shutdown grace.
3. Obtain independent review and exact-SHA approval for this code and the activation manifest. No usable operator manifest has been created by this task.
4. Separately authorize the review-branch push, run all GitHub checks, resolve review findings, then obtain explicit protected-PR merge and exact-SHA Clean RC deployment approval. Auto-Deploy remains unchanged.
5. Run only the separately approved synthetic authorization/withdrawal smoke and pressure checks, observing both durable state and availability errors.

## Known-good rollback

The historical known-good Clean RC reference is 0498646f5721619f91ee710a89386b4b84aaf329; it was not re-queried in this task. Verify the actual deployment artifact and compatible configuration before approving a rollback.

Stop admissions, reconcile uncertain operations and drain/stop the candidate before explicitly restoring the verified prior deployment/configuration through the normal protected operational workflow. Do not reset/force-push Git, restore an older database, erase audits, rewind authorization revisions or change HMAC/JWT values. Current durable revocation/evidence state must remain intact. Do not substitute automatic Work fallback for a rollback. The older release does not provide the new pool/transaction guarantees; keep the environment synthetic-only and pause processing during rollback/reconciliation.

## Disposable validation infrastructure

`node scripts/phase-d-test-infrastructure.mjs up` creates only named, labelled local fixtures on loopback ports 55447 (PostgreSQL) and 55448 (PgBouncer). Existing resources/port collisions fail rather than being replaced. The explicit `down` action verifies labels before removing anything. Its postgres credentials are public disposable test material, never an RC credential.

Use the synthetic test environment from the full-E2E workflow, with DATABASE_URL targeting the disposable direct database and CONTROL_POOL_PGBOUNCER_TEST_URL targeting the matching disposable pooler. Generate Prisma, apply the existing migrations/seed to that disposable database, and build before running the subprocess suite. The workflow now supplies both services and builds before full E2E; it has not been executed remotely by this task. Local testing used the supported cached native Prisma engine path; no live connection was substituted.

Key commands after safe fixture setup are pnpm test:unit, pnpm test:e2e --runTestsByPath test/control-pool-prototype.e2e-spec.ts, pnpm test:e2e, pnpm exec tsc --noEmit -p tsconfig.json, pnpm build, pnpm exec prisma validate, and pnpm lint. Keep both schema/migrations and provider mocks unchanged. Run only against the guarded disposable targets.


## Exact changed files

- `.github/workflows/nightly-e2e.yml`
- `docs/compliance/local-control-pool-prototype-v0.1.md`
- `docs/compliance/phase-d-release-hardening-v0.1.md`
- `scripts/phase-d-test-infrastructure.mjs`
- `src/document-extraction/extraction-operations.service.ts`
- `src/prisma/control-admission.service.spec.ts`
- `src/prisma/control-admission.service.ts`
- `src/prisma/control-database.service.spec.ts`
- `src/prisma/control-database.service.ts`
- `src/prisma/control-pool.configuration.ts`
- `src/prisma/control-request.context.ts`
- `src/prisma/pool-identity.spec.ts`
- `src/prisma/pool-identity.ts`
- `src/prisma/pool-startup.spec.ts`
- `src/prisma/prisma.module.ts`
- `src/prisma/prisma.service.ts`
- `test/control-pool-prototype.e2e-spec.ts`
- `test/helpers/control-process.cjs`
- `test/helpers/control-process.ts`
- `test/helpers/postgres-ack-proxy.ts`


## Local validation record — 2026-11-19

- New/updated focused PostgreSQL and PgBouncer suite: 28/28 PASS, no skips.
- Existing authorization-denial, real-data/AI, extraction retry/resource-limit, confirmation concurrency, quota, mutation and recoverable-deletion suites with isolation enabled: 162/162 PASS across eight suites.
- Focused configuration, identity, startup and control-ownership units: 57/57 PASS across five suites.
- Full PostgreSQL E2E: 388/388 PASS across 49 suites, zero failures/skips, 146.877 seconds, on a freshly recreated disposable database/pooler.
- Full units: 884/884 PASS across 77 suites, zero failures/skips, 30.543 seconds.
- TypeScript, production build, Prisma validation and lint: PASS. Lint retains 12 existing warnings, no new warnings.
- Migration metadata: 60 total, 60 distinct, 60 applied, 0 unfinished. No schema/migration files changed.
- Successful dedicated pressure withdrawals measured 18–29 ms with Work held; these are local observations only, not transferable deployment latency guarantees.
- Workflow structure/build ordering was checked locally. The service-container ID is step-scoped per the [GitHub context reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts). No remote workflow was triggered.

Development failures were investigated rather than hidden:

1. A new fixture typing error and the local native-engine prerequisite were corrected/configured before executable validation; no authorization logic was changed.
2. Upstream queued BEGIN returned UNKNOWN at the request deadline rather than the initially assumed application-acquisition error. The regression now asserts the exact conservative outcome, observed pooler queue, zero callback mutation, no second database submission, and recovery after settlement.
3. Pooler-retained idle backends made global application_name counts unsuitable for attributing one app's connections. Tests now verify exact owned backend PIDs; idle pooled backends remain part of deployment capacity accounting. Recovery uses the explicit whenIdle barrier rather than racing promise settlement.
4. An initial full run was interrupted after appearing stalled. The diagnostic full run returned 381/388 with seven failures: two timing-related cases and five factor checks affected by fixtures left by the interrupted run. Read-only power logs confirmed idle/maintenance sleeps, including 1001 seconds matching a 1009-second quota-suite duration. Drain diagnostics showed no retained admission permits. The fixtures were recreated, and a temporary process-scoped caffeinate assertion prevented idle sleep during the final clean run. It did not change persistent power settings. No test assertion or timeout was weakened, and the failed attempts were not counted as passes.

Local implementation commits:

- D1: eb68699a7cff7315624b1ed1b3c63bfb8dc2684c — explicit RC activation and awaited identity checks.
- D2: 9f1b77e71225fa39d13b96986e4b4b6721e52e98 — bounded control admission and extraction ceiling.
- D3: 4c0bacb36735c9ab2d11b87b7b0192f0f7ec4a2a — PgBouncer, wire-acknowledgement, process-crash, shutdown/overlap fixtures and tests.
- D4 workflow follow-up: 6ed8ce5 — service-container identity scoped to the E2E step.
- Final validation notes are committed separately; their SHA is reported in the operational response.

READY FOR REVIEW locally. Clean RC release remains blocked pending actual operator manifest/endpoint binding, privilege and upstream-capacity evidence, independent review, GitHub CI and explicit exact-SHA deployment approval. The actual RC-positive activation path has not been executed. No usable operator approval or endpoint was fabricated, and no live runtime was contacted.
