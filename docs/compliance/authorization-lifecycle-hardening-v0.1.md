# Final authorization lifecycle hardening — local partial implementation

Baseline: c34903ebb6cb8874626adcb3b76eff2b90a696f0 on fix/phase2-retained-document-security. Correct repository/origin, exact HEAD, clean worktree and ancestry from PR #4 head 4729cfb6f87e2f01b141caa5fda8336f2ef18dad were verified before editing. Phase A–E is present. No live environment or credential was accessed.

## P1: suspension ordering

Before-fix deterministic PostgreSQL reproduction: six focused cases, four passed and two failed. In both absent and already-withdrawn real-data authorization histories, a separate extraction process held its final shared processing fence while suspension nevertheless committed and returned HTTP 201. The expected bounded contention response was HTTP 503 / CONTROL_FENCE_BUSY / NOT_COMMITTED. No assertions or timeouts were weakened.

Every suspension now requires RealDataAuthorizationService and obtains its exclusive organization processing advisory fence inside the owning Control transaction, before reading or updating the organization row. This matches approval/withdrawal ordering and the shared fence held through extraction commit. Subsequent withdrawal reuses the same transaction and transaction-level lock; it introduces no nested transaction or Work-client acquisition. Missing enforcement fails closed.

No-authorization and already-withdrawn organizations use the same ordering point as approved organizations. No AI authorization is required for synthetic local JSON extraction. Authorization, evidence and calculation rules remain unchanged.

Six new cases use independent application processes, actual PostgreSQL transactions and IPC barriers:

- Absent real-data authorization, suspension before final fencing: suspension commits, extraction is denied, result/success evidence/completed lease absent.
- Absent real-data authorization, finalization already fenced: suspension returns bounded contention without mutation/audit, extraction commits, a separately explicit suspension succeeds.
- Already-withdrawn real-data authorization, suspension before final fencing: same denial and unchanged existing decision/evidence history.
- Already-withdrawn real-data authorization, finalization already fenced: same bounded contention and explicit subsequent suspension.
- Required suspension-audit failure with absent authorization: organization/authorization/evidence/audit rollback, explicit retry succeeds once.
- Required suspension-audit failure with withdrawn authorization: same rollback and retained withdrawal history.

The subprocess fixture pauses the actual production final validation before or after its shared fence. Audit failure is injected into the actual owning Control transaction's audit delegate. Provider requests are mocked, though these six cases use synthetic local JSON and need no provider.

After correction: 6/6 focused PASS, 47 pre-existing cases filtered by name, not removed or newly skipped. The complete-suite result below includes all cases without that filter.

## P2: AI grant identity — BLOCKED pending schema/design approval

OrganizationAiAuthorization has organizationId as its sole identity. Its row is overwritten by reauthorization and withdrawnAt is cleared. There is no persisted grant ID or monotonic grant revision. consentVersion identifies consent wording, not a grant. verifiedAt, effectiveAt and updatedAt are timestamps and cannot be substituted for a generation counter. Existing extraction metadata records the real-data decision/revision and AI consent version, not the AI grant generation.

AuditLog has generic append records but no authoritative association or constrained grant-generation sequence for this model. Selecting a latest audit by timestamp, reusing a CUID audit ID as a mutable row surrogate, or embedding an ad hoc grant state into audit payloads would invent a second grant ledger without the required canonical contract. None was implemented.

The required policy is accepted: withdrawing an AI grant must permanently invalidate unfinished operations from that grant; a replacement grant with identical consent wording must not revive them. Already committed valid results must remain unchanged. This policy is NOT yet enforced for withdrawal followed by same-version reauthorization. Existing authorization regression passes must not be represented as proof of this new policy.

Proposed smallest explicit decision (not implemented): add a non-negative, monotonically increasing AI grant revision to the authoritative authorization model. Reserve legacy value zero as unknown; allocate a positive generation atomically under the existing exclusive organization processing fence whenever a replacement grant is recorded. Bind organization ID plus generation into versioned server-owned durable operation metadata and compare it at dispatch and final commit, independently of real-data decision/revision. Withdrawal denies immediately; reauthorization must advance generation; repeated/no-op semantics and overflow must fail safely. Old unfinished metadata without generation must fail closed and require explicit reconciliation, never automatic provider replay. Committed result snapshots are not rewritten.

This requires approval of a new migration and legacy-row/unfinished-operation transition. Migration count would become 61 if a single additive migration is approved; no migration/schema change has been made here. The ten requested AI-generation scenarios remain to be added and validated after that decision, including replacement with identical consent, repeated cycles, tenant mismatch and independent real-data revision checks.

## Changed files

- src/customer-provisioning/customer-provisioning.service.ts — one production change: unconditional exclusive suspension fence before organization-row access.
- test/control-pool-prototype.e2e-spec.ts — six lifecycle regressions and explicitly optional initial approval in the existing fixture (default remains approved for prior tests).
- test/helpers/control-process.cjs — disposable final-fence barriers and required suspension-audit failure injection.
- docs/compliance/authorization-lifecycle-hardening-v0.1.md — reproduction, partial implementation and blocked design decision.

No connection-pool redesign, production AI-policy change, factor change, schema/migration, environment edit, push, PR metadata edit, merge, deployment or real provider call. Production, Preview, RC, Niall and customer data remain untouched. This partial correction is not release-ready.

## Validation

- Before-fix focused PostgreSQL: 4 PASS / 2 FAIL; the two failures were suspension returning 201 instead of contention while extraction held the final shared fence. Forty-seven unrelated tests were filtered by name.
- After-fix focused PostgreSQL: 6/6 PASS; the same 47 cases were filtered, not removed.
- Full units: 884/884 PASS, 77 suites, zero failed/skipped.
- TypeScript, production build, Prisma validation, lint, JS fixture syntax and diff whitespace: PASS. Lint retains 12 existing warnings and zero errors.
- Fresh disposable database metadata: 60 total, 60 applied, zero unfinished migrations.
- No new AI grant-generation tests were executed or claimed: that portion is blocked as described above. Existing AI tests do not certify replacement-grant invalidation.

### Full E2E result and isolated diagnostics

The complete fresh PostgreSQL/PgBouncer run returned 411 PASS / 2 FAIL / 0 skipped across 49 suites (47 passed, two failed), 311.342 seconds. All six new suspension cases passed. Existing real-data authorization 78/78, AI authorization 3/3, tenant isolation 2/2, confirmation concurrency 21/21 and recoverable deletion 8/8 passed. All nineteen Phase E recovery cases passed; the complete Work/Control prototype suite was 52/53.

Failures were retained, not suppressed:

1. Existing five-second withdrawal-budget test received conservative CONTROL_OUTCOME_UNCERTAIN / UNKNOWN instead of the expected CONTROL_TRANSACTION_TIMEOUT / NOT_COMMITTED. It passed unchanged in isolation (1/1; 52 other cases name-filtered). The request deadline can race observation/settlement of the database timeout under scheduling pressure, but this run does not establish the precise cause. No control deadline, assertion or production timeout logic was changed.
2. Existing customer-onboarding demo-safety case exceeded its 30-second budget. Its unchanged isolated suite passed 1/1 in 6.474 seconds. That case does not call the modified suspension path; its full-run timeout cause remains unconfirmed. No onboarding code, fixture or timeout was modified.

The full run remains FAILED; isolated passes do not retroactively make it green or prove baseline equivalence. A clean full regression and independent review/CI remain release requirements. No additional production correction was inferred from these timing failures.

Verdict: BLOCKED. P1 is corrected and locally regression-tested; P2 requires the explicit additive grant-generation schema/design decision. The new AI lifecycle policy is not represented as implemented. No corrected candidate is declared release-ready.
