# AI authorization grant generation — local implementation candidate

Baseline: fix/phase2-retained-document-security at 7cc8878dda68fd155a874a0df7138cb65bb964dc, clean worktree, verified repository/origin and 60 original migrations. This task is local only; no push, PR edit, merge, deployment, live database, credential, real provider or customer data access. RC/Preview/Production/Niall remain untouched.

## Grant contract

OrganizationAiAuthorization.grantGeneration is a non-null PostgreSQL integer, default zero, with a nonnegative CHECK. Zero is unknown/legacy and never provider-eligible. Every newly recorded ENABLED decision, including identical consent wording, allocates previous+1 under the existing exclusive organization processing fence. Organization activity and applicable real-data approval are rechecked inside the owning transaction. Disabled decisions and withdrawal preserve the counter. Exhaustion at 2147483647 fails closed without audit or state mutation; no wrap/reset. Clients cannot supply generation fields.

The authorization write and required audit commit atomically. AI issuance and withdrawal audits retain the generation. Real-data-triggered AI withdrawal also preserves and audits the generation; real-data decision/revision remains independent. AI-only changes do not fabricate HMAC compliance evidence. A post-callback transaction failure returns 503 / AI_GRANT_OUTCOME_UNCERTAIN / UNKNOWN with reconciliationRequired=true and automaticRetry=false. An actual dropped COMMIT completion verifies durable generation/audit without a second issuance.

The single additive migration is 20261119000000_ai_grant_generation. Existing migration files are unchanged. Its trigger guards reject generation decrease, organization reassignment, standalone authorization deletion and table truncation. Organization-erasure cascades are allowed only after the owning organization row is gone; the old tenant's jobs cascade with it. The trigger executes as invoker, without privilege elevation, and explicitly looks up public.Organization. Runtime paths cannot delete/recreate an authorization to reuse an old generation. Privileged trigger disabling/database restoration is outside the application boundary and must not rewind counters or evidence during operations.

## Durable operation version 2

Provider operations persist the authoritative positive aiGrantGeneration alongside organization/document identity, provider/scope, consent version, and independent real-data decision/revision. Local JSON/XLSX uses null generation and still needs real-data approval when its persisted data mode is REAL_CUSTOMER_DATA. Synthetic provider admission now takes the same shared fence before selecting its AI grant, preventing issuance/withdrawal from interleaving through admission. No storage or provider I/O is moved into the transaction.

Dispatch and final commit require an exact current generation, provider, scope and tenant match, plus existing effective-consent, runtime gates, source identity and lease checks. Missing, malformed, unknown-version or replacement-grant operations fail closed. Metadata is never upgraded to a current grant. Required result/audit/activity/lease completion remains in one owning transaction. Old committed results and operation history are preserved when a new grant is issued.

## Legacy recovery and deployment

No positive generation backfill occurs. Existing approved generation-zero rows are ineffective until explicit administrator reissuance. Withdrawn/disabled rows remain ineffective. Version-1 operations cannot dispatch or finalize. A restricted transaction-aware retireLegacy helper can retire an expired/abandoned version-1 operation, but cannot authorize processing or external replay. Required retirement audit/activity evidence, failure status and lease release share its owning transaction; completed jobs are no-ops and newer document attempts are protected. Original metadata and dispatch history remain available, with provider delivery labelled UNKNOWN. Same-document admission refuses legacy or malformed active identities until explicit reconciliation. The durable quota expiry sweep uses the canonical version-2 parser and job/tenant/document identity checks; it leaves unknown jobs intact, including unknown jobs for another document. Legacy direct quota helper behavior is preserved, but is not a supported processing path for the new durable runtime.

Drain provider admissions and AI-decision writes before upgrading. Reconcile in-flight and uncertain delivery, stop old writers, migrate once, then start only generation-aware runtimes. Reissue only separately approved grants. A new explicit attempt is not permission to automatically repeat an unknown provider request.

No writable old/new provider-runtime overlap is supported. Keep migration/counters/audits on rollback; never down-migrate, restore an older database, or reset a counter. Prior runtime provider and AI-decision writes must be blocked by an independently verified operational gate unless a reviewed backport exists. The local rollback fixture models this REQUIRED gate with read-only middleware; it does not add such protection to the historical application or certify a real deployment gate.

The prior-source artifact now generates a separate historical Prisma client from the old schema, rather than silently using the current model. Its package/lock must match exactly and the only permitted schema difference is the reviewed grant-generation field. PostgreSQL tests exercise actual old-client reads against the additive database, reject old writes under the explicit gate, and check that current counters/history remain unchanged. All artifact construction uses guarded temporary directories and synthetic generation settings.

## Intermittent-test investigation

The retained withdrawal failure was UNKNOWN after 5162 ms; its isolated pass took 5312 ms. A simple six-second timer explanation was therefore insufficient. The existing test externally observed PostgreSQL rollback, then released a callback that could still return before Prisma rejected its transaction. Production deliberately treats callback-completed errors as UNKNOWN, including P2028. Two new unit cases deterministically distinguish P2028 before callback completion (NOT_COMMITTED) from rejection after completion (UNKNOWN).

The PostgreSQL known-rollback test now queries the expired transaction inside the released callback. That forces its rejection before callback completion and keeps the original exact timeout/NOT_COMMITTED and under-six-second assertions. Sanitized settlement diagnostics record only rejection/code/timing. No budget or security assertion was relaxed.

The onboarding timeout has no established root cause. Test-only, pre-initialization middleware records safe route labels/templates, method, status and monotonic duration, never raw query strings, bodies, setup links, JWTs or tokens. Scheduling histograms record event-loop mean/max/p99 and RSS for onboarding and control suites. These observations distinguish outstanding HTTP stages from scheduling pressure; they do not by themselves prove connection contention or fixture contamination. No onboarding behavior or timeout is changed.

## Development evidence

Four initial PostgreSQL regressions failed against the unchanged baseline: generation was absent, durable metadata was version 1, and replacement consent did not invalidate the admitted operation. After implementation those four passed. The expanded focused run passed 25/25 generation cases (53 unrelated cases name-filtered). Additional withdrawal-only dispatch/finalization cases are included in the complete run.

A rollback fixture startup failure was traced to local artifact-path whitespace and then to the custom generated client's ESM marker differing from the installed package's CommonJS wrapper. The isolated historical-client package now preserves that wrapper behavior; the old-client read and blocked-write test passed. A unit fixture missing a positive generation was corrected so its unchanged real-data-revision rejection assertion still tests that independent gate. No denial expectation was weakened.

One development full run exposed an obsolete malformed-version fixture: version 2 was previously invalid but is now the supported contract. The negative test must use an unsupported version and retain its fail-closed assertion. Full-run failures and final counts are recorded below, not silently treated as passes.

## Exact changed-file scope

Production: src/ai-authorization/ai-authorization.service.ts; src/document-extraction/extraction-operation.ts; src/document-extraction/extraction-operations.service.ts; src/organization-quotas/organization-quotas.service.ts; src/real-data-authorization/real-data-authorization.service.ts.

Schema/migration: prisma/schema.prisma; prisma/migrations/20261119000000_ai_grant_generation/migration.sql.

Tests/fixtures: src/ai-authorization/ai-authorization.service.spec.ts; src/document-extraction/ai-consent-gate.spec.ts; src/prisma/control-database.service.spec.ts; test/control-pool-prototype.e2e-spec.ts; test/customer-onboarding-demo-safety.e2e-spec.ts; test/helpers/control-process.cjs; test/helpers/e2e-app.ts; test/real-data-authorization.e2e-spec.ts.

Artifact tooling: scripts/phase-e-rollback-artifact.mjs. Documentation: this file. No dependency, workflow, deployment or environment file changed.

The new migration's SHA-256 is fda899f70cb6f9f15ae2cc92acfb4838064454fd120c2bc5bafb9cd277d040de. All sixty pre-existing migration/reference files were byte-compared to the baseline and remain unchanged.

## New deterministic generation cases
- Grant generation starts at one and binds version-two durable admission
- Grant generation withdrawal and identical-consent replacement cannot revive old dispatch
- Grant generation replacement rejects old finalization and rolls back protected writes
- Grant generation replacement cannot authorize missing generation metadata
- Grant generation B processes while completed A results remain unchanged across repeated cycles
- Grant generation replacement during provider work rejects the old response without replay
- Grant generation rejects malformed missing metadata
- Grant generation rejects malformed null metadata
- Grant generation rejects malformed zero metadata
- Grant generation rejects malformed negative metadata
- Grant generation rejects malformed text metadata
- Grant generation rejects malformed fraction metadata
- Grant generation rejects malformed overflow metadata
- Grant generation rejects cross-context organizationId identity
- Grant generation rejects cross-context provider identity
- Grant generation rejects cross-context processingScope identity
- Grant generation issuance and audit roll back together without consuming a generation
- Grant generation concurrent issuance and withdrawal serialize without counter reuse
- Grant generation is server-owned, cannot reset through deletion, and fails closed on exhaustion
- Grant generation remains independent of real-data decisions and rejects expired leases
- Grant generation legacy PENDING jobs require explicit audited retirement before retry
- Grant generation legacy RUNNING jobs require explicit audited retirement before retry
- Grant generation zero is ineffective until explicit reissuance and local extraction has null generation
- Grant generation lost issuance acknowledgement returns UNKNOWN without another grant
- Grant generation rollback reads with the actual old Prisma client but blocks all old writes
- Grant generation migration preserves existing fields and assigns only unknown zero
- Grant generation withdrawal alone rejects admitted dispatch without success or completed lease
- Grant generation withdrawal alone rejects admitted finalize without success or completed lease
- Grant generation quota expiry preserves an unknown other-document operation for reconciliation


## HTTP timing diagnosis and fixture ownership

A fresh complete run returned 440/442 PASS with two unchanged customer-safeguards cases timing out at 30 seconds. Both passed unchanged in a targeted diagnostic run alongside onboarding and the withdrawal-budget case (4/4 selected PASS; 81 unrelated cases filtered).

A subsequent fresh request-traced diagnostic run reproduced authorization-boundary stalls. It was interrupted after obtaining evidence; no complete total is claimed for that interrupted run. Sanitized traces showed client-start events without corresponding server request events, while read-only local PostgreSQL occupancy showed idle sessions and no database lock wait. The observed stall was before Nest/Prisma, not an authorization-denial response. This does not retrospectively prove the exact cause of the historical onboarding timeout.

Supertest's installed serverAddress/end implementation automatically binds and closes an unowned server around individual requests. The E2E helper now explicitly awaits one loopback listener after initialization and owns it until app.close(). This removes that per-request listen/close lifecycle from the fixture. Application routes, guards, TLS/production configuration and test budgets are unchanged. A new regression verifies ready/stable listener address across authenticated 200 and unauthenticated 401 requests, then listener closure during application shutdown.

The targeted listener/authentication/mutation/onboarding checks passed 11/11 after correcting only a type-narrowing error in the new listener test (85 unrelated cases name-filtered). The external generic request tracer is not committed and is not a runtime dependency. Historical intermittent-failure attribution remains qualified; full CI is still required.

The migration now encloses column/check/function/trigger creation in an explicit PostgreSQL transaction. A regression injects a failure before COMMIT and verifies the new column and guard function both roll back, then cleans only its isolated synthetic schema. No database down-migration was added.

Additional exact regression names:

- Grant generation migration failure rolls back the column and reset guards together
- E2E fixture owns a stable ready listener through authorized and denied requests and shutdown

The final focused grant suite passed 30/30 (54 unrelated tests name-filtered). It includes representative old-row zero backfill, transactional migration-failure rollback, pending/running legacy retirement, prevention of silent cross-document expiry, replacement grants, exhausted counters, lost acknowledgement, actual old-client read compatibility, and unchanged completed version-1 history. The listener/authentication/onboarding diagnostic suite passed 11/11 selected cases (85 unrelated cases filtered). These filters are not new skips in the full suite.

Final full units passed 886/886 across 77 suites, zero skips. TypeScript, production build, Prisma validation, lint, helper/artifact JS syntax and diff whitespace checks passed. Lint retains twelve existing warnings, zero errors. No production authorization expectation or test timeout was relaxed.

The development full run at the expanded 442-test scope returned 440 PASS / 2 FAIL / 0 skipped, with customer-safeguards timeouts. The earlier 440-test development run returned 439 PASS / 1 FAIL / 0 skipped for the stale invalid-version fixture. Neither is counted as a green run. A later request-traced run was interrupted after obtaining pre-server transport-stall evidence; no aggregate pass count is claimed for it. External request tracing and progress reporters reside only in the temporary operator workspace, are not committed and are not deployment dependencies.

Remaining deployment gates: independent exact-candidate security review, GitHub CI, explicit migration/deployment approvals, runtime column/function privileges, actual Neon/PgBouncer competing-consumer capacity, and verified admission drain/read-only rollback controls. Writable old/new provider runtime overlap is unsafe. No live activation, positive legacy backfill, automatic database down-migration, counter rewind, evidence deletion or provider replay is authorized. Local timing is not a Neon/Render latency guarantee.

## Final clean-infrastructure validation

The final run used a newly recreated labelled disposable PostgreSQL/PgBouncer environment, the wrapped migration and the application-owned ready listener. It used no generic HTTP patch/tracer and changed no assertions or budgets:

- Full PostgreSQL/PgBouncer E2E: **444/444 PASS**, 49/49 suites, zero failed/skipped, 224.708 seconds.
- New grant-generation cases: **30/30 PASS** within that full run.
- Full Work/Control prototype/concurrency/recovery suite: **84/84 PASS**, including existing Phase D/E and suspension regressions plus generation/listener coverage.
- Full units: **886/886 PASS**, 77 suites, zero failed/skipped.
- TypeScript, build, Prisma validation, lint, JS syntax and diff whitespace: PASS; twelve existing lint warnings, zero errors.
- Disposable migration metadata: **61 total / 61 distinct / 61 applied / 0 unfinished**. The stored checksum matches the file SHA-256 printed above. All sixty original migrations remain unchanged.

All four previously observed timeout cases passed in the final full run. The captured client/server boundary evidence and successful owned-listener validation support the fixture-lifecycle diagnosis; this does not prove every historical timeout had the same cause. CI and independently reviewed deployment evidence remain required. Production control timing semantics were not relaxed to force a green result.

This candidate resolves the local AI-generation design blocker recorded in authorization-lifecycle-hardening-v0.1.md. That report's historical validation results remain historical, not rewritten as passes. READY FOR RE-REVIEW locally; not approval to push, merge, migrate or deploy Clean RC.
