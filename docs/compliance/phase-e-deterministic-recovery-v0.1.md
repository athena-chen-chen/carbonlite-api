# Phase E Stage 2 — deterministic recovery validation

Baseline: fix/phase2-retained-document-security at 3186dacbae22c81358e1fa2e91e08af589092b45. Repository identity, clean worktree, Phase A–D lineage, and absence of schema/migration changes were checked before editing. All execution is disposable-local only. No actual RC activation or operator manifest was used.

## Confirmed defect and minimal production correction

A real protocol proxy dropped PostgreSQL's COMMIT completion after the extraction-result transaction committed. Both real-data JSON and mocked provider-style cases verified complete durable result, required audit/activity evidence, document status and completed lease before failing the expected response assertion. The baseline returned generic HTTP 500 with retry guidance instead of an uncertain outcome.

Before-fix reproduction: 0/2 PASS, 2/2 FAIL on the response assertions; durable-state assertions passed. This is an outcome-reporting/retry-guidance defect, not reproduced partial persistence or lost data.

Only src/document-extraction/document-extraction.service.ts changes production behavior:

- persistExtraction marks its callback prepared only after protected writes, required evidence, final revision fence and operation completion finish inside the owning transaction.
- A subsequent transaction failure reports HTTP 503, EXTRACTION_OUTCOME_UNCERTAIN, outcome UNKNOWN, reconciliationRequired=true and automaticRetry=false. No raw driver payload is exposed.
- extract does not append failure-state evidence or authorize a replay for that uncertain exception.
- Exceptions before callback completion preserve existing rollback, denial and failure behavior. A post-callback failure may represent commit or rollback; it is conservatively uncertain until reconciled.

The proxy also drops COMMIT before transmission in a separate case. The client still reports uncertainty, while authoritative restart inspection confirms rollback. The live lease blocks immediate retry; a separately explicit attempt after deterministic expiry completes once. This distinction does not pretend the client can infer rollback from a transport error.

No authorization, consent, tenant, factor, calculation, schema, migration, pool or deployment policy is relaxed. No provider SDK request is made: subprocesses replace the provider module before application imports, and parent E2E uses the existing provider mock.

## Stage 1 gap disposition

| Gap | New evidence | Disposition |
| --- | --- | --- |
| Final-result commit ambiguity | Real JSON/provider COMMIT-ack drops; full durable state; restart with no replay or duplicate publication; COMMIT-before-send rollback comparison | Covered locally; outcome defect corrected |
| Provider dispatch/response boundaries | Hard kill after admission commit before send and after stub response before persistence; durable dispatch identity/audit; live-lease withdrawal fence rolls back a provisional write, then expired-lease rejection | Covered locally; no exactly-once claim |
| Physical deletion | Hard kill after PREPARED intent, quarantine move and deletion commit; deletion COMMIT-ack drop; restart and explicit idempotent completion | Covered locally; bytes remain quarantined, canonical ActivityData/snapshot survives, committed deletion audit exactly one |
| Lease expiry during downtime | Retry before expiry denied; withdrawal and different revision/decision while worker dead; expiry before restart; explicit new attempt; old finalization cannot overwrite | Covered locally |
| Concurrent control operations | Two real processes, same tenant, both first-winner orderings, bounded fence contention, explicit later submission, atomic withdrawal/suspension evidence, unrelated user/org unchanged | Covered locally |
| Deadline/connection recovery | Two-process application-pool saturation; repeated upstream deadlines; retained bounded admissions; connection interruption; settlement barrier; protected mutations after recovery | Covered locally; target pooler behavior remains operational evidence |
| Shutdown | SIGTERM with prepared mutation, then SIGKILL during cooperative drain; rollback/no false withdrawal; restart reconciliation and separate explicit withdrawal | Covered locally; platform grace remains unverified |
| Activation/rollback | Actual SQL identity failures in each startup pool, all selected application-table counts unchanged, both constructed clients closed, positive awaited startup-write sentinel; immutable prior-source build reads durable history unchanged | Covered locally; actual RC manifest/artifact approval remains operational |

## Important test boundaries

- Dispatch admission is an ordering/evidence point, not proof of external delivery. After a crash, delivery can remain unknown even when a lease is expired. Startup does not automatically replay. Any new test request after reconciliation/expiry is a distinct explicit synthetic action.
- Physical deletion tests use normal extraction/confirmation to create calculated ActivityData with a non-null snapshot, then compare preserved fields after deletion. Document FK becomes null, source lineage remains, drafts cascade, quarantine bytes remain, and completed deletion has one audit. No purge is performed by an uncertain request. Test-owned quarantine is cleaned only after assertions.
- PgBouncer tests distinguish backend waiting from application-client exhaustion. Repeated deadline attempts return UNKNOWN, excess attempts are rejected without queuing, and the same clients recover after settlement. This does not prove successful withdrawal during unrelieved global saturation or an infrastructure SLA.
- The startup failure tests run the real AppModule factories with read-only local identity checks and intentionally wrong expected identities. They do not bypass the RC configuration guard to connect synthetic credentials to RC.
- The rollback artifact is source SHA 0498646f5721619f91ee710a89386b4b84aaf329, built in a guarded temporary directory without checkout/reset. Its package.json, lockfile and Prisma schema must exactly match before current dependencies are reused. The test starts that local prior build, performs authenticated read-only access, and verifies authorization/evidence/audit and application counts unchanged. It does not claim to have restored the actual Render artifact or validated every older write path.
- The workflow obtains complete source history for that immutable build and creates the artifact before E2E. This workflow change is local only; GitHub CI has not been triggered.

## Remaining operational dependencies

Independent review, actual Neon endpoint/project/branch binding, runtime privileges and capacity, competing consumers, Render shutdown/overlap behavior, GitHub CI and exact-SHA deployment approval remain required. No live environment was accessed. No separate role/direct Control endpoint or credential was introduced. The older release's pool demand remains a rollback planning item.

Local deterministic evidence is not transferable to Neon/Render as a latency or reservation guarantee. Existing durable withdrawal/evidence state must survive any separately approved deployment rollback; no database restore, ledger rewind, HMAC change or automatic provider replay is part of this work.

## New focused test names

- Phase E final-result COMMIT acknowledgement loss is truthful and reconciles after restart: provider=false
- Phase E final-result COMMIT acknowledgement loss is truthful and reconciles after restart: provider=true
- Phase E provider boundary dispatch-before-send cannot publish after downtime withdrawal
- Phase E provider boundary after-provider-response cannot publish after downtime withdrawal
- Phase E lease expiry during downtime fences old decisions and preserves a newer result
- Phase E physical deletion recovers deletion-prepared without losing confirmed evidence
- Phase E physical deletion recovers deletion-quarantined without losing confirmed evidence
- Phase E physical deletion recovers deletion-committed without losing confirmed evidence
- Phase E physical deletion recovers deletion-ack without losing confirmed evidence
- Phase E two-process same-tenant control race serializes withdraw first
- Phase E two-process same-tenant control race serializes suspend first
- Phase E forced termination during shutdown rolls back the pending withdrawal and reconciles
- Phase E two-process saturated Work and Control pools recover to authenticated mutations
- Phase E repeated upstream deadlines and connection interruption recover without queued mutations
- Phase E observer-confirmed rollback differs from a lost COMMIT acknowledgement
- Phase E actual SQL identity failure in work prevents startup writes and closes constructed clients
- Phase E actual SQL identity failure in control prevents startup writes and closes constructed clients
- Phase E startup hooks cannot write until both actual identity checks finish
- Phase E isolated prior-build rollback preserves durable withdrawal and evidence history

## Changed files

- src/document-extraction/document-extraction.service.ts — the single production correction for uncertain final-result outcomes.
- test/control-pool-prototype.e2e-spec.ts — nineteen new deterministic PostgreSQL/PgBouncer recovery cases and test-owned quarantine cleanup.
- test/helpers/control-process.cjs — guarded synthetic subprocess checkpoints, IPC probes and prior-build support.
- test/helpers/control-process.ts — per-process fixture settings and read/delete request support.
- test/helpers/postgres-ack-proxy.ts — before-COMMIT comparison and connection interruption for loopback fault injection.
- scripts/phase-e-rollback-artifact.mjs — immutable, dependency/schema-checked prior-source artifact construction.
- .github/workflows/nightly-e2e.yml — fetch immutable history and build the rollback test artifact before E2E.
- docs/compliance/phase-e-deterministic-recovery-v0.1.md — evidence, limitations and validation record.

## Validation record

- Before correction: final-result lost-ack regressions 0/2 PASS; both failed only the expected uncertain-response assertions, after durable-state checks passed.
- After correction: new Phase E focused cases 19/19 PASS (28 pre-existing cases filtered by name, not removed or newly skipped).
- Strengthened live-lease provider-boundary checks: 2/2 PASS.
- Existing focused authorization/tenant/extraction/confirmation/deletion regressions: 190/190 PASS, no skips.
- Full units: 884/884 PASS across 77 suites, no skips.
- TypeScript, production build, Prisma validation and lint: PASS; lint retains 12 existing warnings, zero errors. JS helper/artifact syntax checks and git diff whitespace checks pass.
- Local migration metadata: 60 total, 60 distinct, 60 applied, zero unfinished. No Prisma schema or migration file changed.

### Failed and diagnostic runs retained

An initial complete run returned 401/407 PASS, with five existing authorization-boundary timeouts and one duplicate-upload socket error. The authorization-boundary suite subsequently passed 10/10 unchanged with external request tracing. No timeout, assertion, or security guard was relaxed. The transport/timeouts are not attributed to a confirmed code cause.

A subsequent full run on the reused database returned 400/407 PASS: one existing XLSX-upload 404, five factor-deployment gate failures caused by residual reviewed synthetic factors, and one bootstrap zero-state assertion caused by residual fixtures from an interrupted diagnostic run. This contaminated run is not accepted as final validation. Only labelled disposable PostgreSQL/PgBouncer containers were recreated for the final run. External diagnostics record request methods/paths/statuses only, never credentials, request bodies, JWTs or provider payloads; they are not committed.

During test development, four physical-deletion cases initially failed because their explicit empty confirmation payload intentionally confirmed no staged rows. The fixture now supplies the supported synthetic activity DTO and asserts a non-null snapshot before deletion. A separate overlapping build/test attempt caused nine subprocess startup failures when build replaced dist; serial build-before-subprocess execution resolved those failures. These were fixture/execution corrections, not changes to factor or confirmation eligibility.

### Final clean-infrastructure result

The final complete PostgreSQL/PgBouncer E2E run passed 407/407 tests across 49/49 suites, zero failed and zero skipped, in 221.49 seconds. It includes all 47 Work/Control prototype cases (28 existing plus 19 new). Request-only external tracing was retained to diagnose any recurrence; it changed no application behavior or assertion and produced listener-count warnings from accumulated diagnostic hooks. That tracer is outside the repository and is not a release dependency. The earlier timeout/socket/404 symptoms did not recur, but their transport cause remains unconfirmed and should not be described as fixed by this patch. GitHub CI remains a required independent check.

Final migration metadata after the clean reset again returned 60 total / 60 distinct / 60 applied / 0 unfinished. Full unit and static-check results above are from the final source state. No test timeouts were increased, cases skipped, negative assertions removed or provider policies relaxed.

The two-process application-client ceiling exercised is 12 connections (two processes times Work=4 plus Control=2), with separate local observer/pressure clients where specified. The upstream pressure fixture deliberately limits PgBouncer to two backend connections; it demonstrates bounded rejection/uncertainty and subsequent recovery, not reserved control-plane capacity under indefinite upstream exhaustion.

Verdict: READY FOR FINAL INDEPENDENT REVIEW. This is not approval to activate or deploy Clean RC. No push, merge, deployment, live queries, credentials, customer data, actual provider calls, RC/Preview/Production or Niall changes occurred.
