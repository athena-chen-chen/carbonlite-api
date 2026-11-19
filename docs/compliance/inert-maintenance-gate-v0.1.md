# Clean RC inert maintenance gate — local review candidate

This is local implementation/rehearsal evidence, not approval to change Render, Neon, credentials, ingress, or deployments. The preparation branch starts at release e3d2c608f805f1065eb0f944efd07c3003e1d2cb. Existing deployment commands, application code, schema and migrations are unchanged.

## Standalone process and threat boundary

Proposed Render Start Command:

```sh
node scripts/inert-maintenance.mjs
```

The executable imports only node:http and node:url. It does not load dotenv, Nest, Prisma, application initialization, storage, a provider SDK, or migration tooling. It uses no filesystem API or outbound connection API. It binds exactly PORT, with no alternative-port fallback. Only GET/HEAD /api/health/live returns 200. That response explicitly says applicationReady=false. All other ordinary routes/methods return 503, including readiness, login, processing, authorization, private-host requests and loopback requests. CONNECT and Upgrade are explicitly denied with 503; malformed HTTP may be disconnected by the parser. There is no mutation endpoint or admin bypass. No request headers, URLs, bodies, document data, environment values or raw error details are logged. Fixed activation/listen failure labels and one fixed ready label are the only diagnostics.

Headers and request/socket inactivity budgets are one second. SIGTERM/SIGINT stops listening; an independent one-second timer destroys remaining sockets and exits. This bounds application shutdown work, subject to OS scheduling, rather than claiming a hosted SLA.

This is not an OS sandbox or a database access-control mechanism. A privileged operator could run another command in the same container. External writers, shell processes, one-off jobs and schedules require independent exclusion. Merely configuring a frontend maintenance notice or obtaining an empty AIJob count does not prove drain: the old runtime could process without a job when quota enforcement was disabled.

## Identity settings

Live-mode requirements (values below are non-secret configuration; placeholders must never be used as approvals):

| Setting | Required value |
| --- | --- |
| MAINTENANCE_GATE_MODE | clean-rc-v1 |
| APP_ENV / NODE_ENV | rc / production |
| RENDER | true, supplied by Render |
| RENDER_SERVICE_ID | srv-dbtppde7bikc73fcg2j0 |
| RENDER_GIT_BRANCH | release/phase2-real-data-rc |
| MAINTENANCE_RELEASE_SHA | e3d2c608f805f1065eb0f944efd07c3003e1d2cb |
| MAINTENANCE_APPROVED_DEPLOYMENT_SHA | Exact separately approved maintenance artifact SHA; must equal Render's RENDER_GIT_COMMIT |
| MAINTENANCE_APPROVAL_REFERENCE | Genuine separately recorded operator approval reference |
| MAINTENANCE_LIVENESS_PATH | /api/health/live |
| PORT | Render-supplied port, integer 1–65535 |

The script cannot be deployed from e3d2c608 itself because that immutable commit does not contain it. Publishing/integrating this preparation requires separate authorization; if merged, approval must name the resulting maintenance deployment SHA. The later normal application deployment may still target exact e3d2c608. No self-referential commit SHA or approval has been invented.

The approval reference is an operator assertion with syntax checks, not a signature or independent authorization service. Environment bindings do not provide cryptographic artifact attestation. No database endpoint identity is needed by this process because it never connects; the later application still requires the independently verified endpoint and its own Control Pool manifest. Do not copy or display credentials while preparing these non-secret settings.

Disposable mode is separate: APP_ENV=NODE_ENV=test, no RENDER variable, fixed synthetic service/branch/SHA/approval identifiers, loopback bind only. Mixing actual Render execution with disposable mode fails before listen. Production identity configuration is tested as a pure function without starting a production-mode listener or pretending the test reference is an operator approval.

## Planned save/deploy sequence — not executed

1. Obtain independent review, publication/integration approval and exact-SHA maintenance deployment approval. Keep Auto-Deploy OFF. Inventory pending deploys and freeze external writers and operational shell/cron/one-off processing.
2. Enable and verify Render Maintenance Mode under separate approval. It blocks public HTTP, but Render documents that private network and SSH access remain available. Drain/reconcile old work and uncertain provider delivery without automatic replay.
3. Stage the non-secret maintenance configuration and standalone Start Command using the Dashboard's save-without-deploy action only if available and verified. Stop if the UI would deploy a different artifact or restart the old application. Do not choose Restart service: Render documents that restart uses the currently running deployment's prior configuration.
4. Use Manual Deploy > Deploy a specific commit for the approved maintenance SHA. Do not use Suspend/Resume, Deploy latest commit, a deploy hook, or old-runtime rollback. Keep Build Command unchanged and Pre-Deploy Command empty: no migration belongs in build/pre-deploy for this cutover.
5. Render documents that disk-backed deployments stop the existing instance before starting its replacement. Verify actual old-instance termination, exact new SHA, gate-only logs and successful maintenance deployment. Probe public ingress and approved private/loopback requests. Maintenance liveness 200 does not establish application/database readiness.
6. Record the maintenance deployment ID, artifact retention and configuration snapshot, exact Start Command/SHA, disk identity/mount and evidence of no remaining old/external writer. Preserve managed files/quarantine/deletion intents and approved database/file metadata. This evidence is required BEFORE separately approved Migration 61. A 503 alone or an empty job table is insufficient.
7. Only after exclusion, separately approve/run Migration 61 using the secure migrator workflow, verify 61 applied/0 unfinished, and reconcile legacy operations. This script neither executes migrations nor grants that approval.
8. Stage the normal application Start Command node dist/main.js and independently approved RC activation manifest bound to e3d2c608. Keep public ingress/external writer exclusions. Deliberately transition the recovery HTTP lock only as separately approved so private health/authorization verification is possible; do not silently remove it. Deploy exact e3d2c608 by normal exact-commit deployment, not Restart service.
9. Verify both pool identities before application startup writes, liveness/readiness, migration and record/file preservation, then separately approved synthetic smoke. No grant reissuance or gate removal is implicit.

Saving configuration and exact-SHA branch metadata behavior need operator verification at action time. No Dashboard save/deployment behavior was exercised in this task. If Render cannot stage settings without an unsafe intervening deployment, stop for a revised procedure.

## Recovery and rollback

Before the inert deployment is successful, failure must leave migration unexecuted. After migration, never return to writable old application 0498646. Render documents that rollback uses the selected target's Start Command and environment snapshot. A recorded, retained, successful INERT deployment is the only proposed immediate rollback target; verify it still has this gate's identity requirements. Do not assume a newer configuration protects an older application rollback.

If generation-aware activation fails, keep ingress closed and recover forward or deliberately restore that reviewed inert deployment. Do not assume Render's disk-backed failure handling always leaves a particular process running: inspect actual state. The required invariant is no old writer, even if the service remains unavailable. Do not down-migrate, reset grant generations, restore an older database/disk snapshot, purge quarantine or replay uncertain provider work. A separate compatibility-safe recovery artifact needs separate review/approval.

## Disposable validation and limitations

Run:

```sh
node --test test/inert-maintenance.test.mjs
```

Tests use subprocesses with an explicit synthetic environment (no inherited credential/URL settings), temporary synthetic record/document files and loopback HTTP. The test-only preload instruments outbound socket/TLS/fetch attempts, application/provider CommonJS imports and filesystem writes, and reports only violation labels by IPC. Static import-graph assertions independently restrict the real executable to its two builtins. The executable never loads the observer in deployment.

Assertions include activation before listen; service/SHA/mode/release/path/port mismatches; RC configuration shape without a live RC listener; liveness only; route/method/private-host/loopback/CONNECT/upgrade denial; no request-secret logging; no outbound calls or filesystem writes; stable synthetic records/files through repeated starts, refused replacement and return to the known-good inert process; configured-port collision without fallback; and bounded SIGTERM with an unfinished connection. Ordering uses ready/IPC/connection/exit events, not arbitrary sleeps.

The file fixtures are synthetic preservation stand-ins, not a PostgreSQL or Render rollback rehearsal. No database queries were run. Local host-header and loopback denial does not prove actual Render private networking. Actual disk attachment, ingress, process termination, configuration rollback and upstream infrastructure remain deployment verification requirements.

Development failures were corrected without weakening assertions: an initial test syntax error; invalid subprocess activation retaining the observer IPC handle until the executable was changed to exit explicitly; and fixture-only lint issues resolved by ESM imports/explicit builtin imports. Final counts and commit identity are reported with the review response.

Final local results: 17/17 PASS, zero skips/failures/cancellations on Node 22.23.4 and Node 20 (registry-provided disposable test runner). The Node 22 run completed in 3.56 seconds and the Node 20 run in 2.04 seconds. Syntax checks for all three executable/test files and focused ESLint passed. No application suites, Prisma commands, database queries or infrastructure were started. Existing Phase D/E results were not rerun or represented as gate-specific evidence.

Official platform references: [Maintenance Mode](https://render.com/docs/maintenance-mode), [deployment steps and exact commits](https://render.com/docs/deploys), [persistent disk limitations](https://render.com/docs/disks#disk-limitations-and-considerations), [rollback configuration](https://render.com/docs/rollbacks#whats-rolled-back). These documented primitives do not certify this service's future cutover.
